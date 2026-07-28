#!/usr/bin/env node

import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API_ROOT = "https://api.github.com";
const API_VERSION = "2022-11-28";
const CARD_WIDTH = 820;
const CARD_HEIGHT = 220;
const token = process.env.GITHUB_TOKEN;
const owner =
  process.env.GITHUB_REPOSITORY_OWNER ||
  process.env.GITHUB_REPOSITORY?.split("/")[0];

if (!token) {
  throw new Error("GITHUB_TOKEN is required");
}

if (!owner) {
  throw new Error(
    "GITHUB_REPOSITORY_OWNER or GITHUB_REPOSITORY is required",
  );
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const outputDirectory = process.env.PROFILE_STATUS_OUTPUT_DIR
  ? path.resolve(process.env.PROFILE_STATUS_OUTPUT_DIR)
  : path.join(repositoryRoot, "profile-status");

const palettes = {
  light: {
    background: "#ffffff",
    surface: "#f6f8fa",
    border: "#d0d7de",
    text: "#1f2328",
    muted: "#59636e",
    blue: "#0969da",
    green: "#1a7f37",
    purple: "#8250df",
    orange: "#bc4c00",
    cyan: "#1b7c83",
  },
  dark: {
    background: "#0d1117",
    surface: "#161b22",
    border: "#30363d",
    text: "#f0f6fc",
    muted: "#8b949e",
    blue: "#58a6ff",
    green: "#3fb950",
    purple: "#bc8cff",
    orange: "#d29922",
    cyan: "#39c5cf",
  },
};

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function ellipsize(value, maximumLength) {
  const text = String(value);
  return text.length > maximumLength
    ? `${text.slice(0, maximumLength - 1)}…`
    : text;
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function completedYears(createdAt, currentDate = new Date()) {
  const created = new Date(createdAt);
  let years = currentDate.getUTCFullYear() - created.getUTCFullYear();
  const beforeAnniversary =
    currentDate.getUTCMonth() < created.getUTCMonth() ||
    (currentDate.getUTCMonth() === created.getUTCMonth() &&
      currentDate.getUTCDate() < created.getUTCDate());

  if (beforeAnniversary) {
    years -= 1;
  }

  return Math.max(0, years);
}

async function githubRequest(endpoint) {
  const response = await fetch(`${API_ROOT}${endpoint}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "profile-status-generator",
      "X-GitHub-Api-Version": API_VERSION,
    },
  });

  if (!response.ok) {
    const message = (await response.text()).slice(0, 300);
    throw new Error(
      `GitHub API request failed (${response.status} ${response.statusText}) for ${endpoint}: ${message}`,
    );
  }

  return response.json();
}

async function fetchPublicRepositories(login) {
  const repositories = [];

  for (let page = 1; ; page += 1) {
    const batch = await githubRequest(
      `/users/${encodeURIComponent(login)}/repos?type=owner&sort=pushed&direction=desc&per_page=100&page=${page}`,
    );
    repositories.push(...batch);

    if (batch.length < 100) {
      return repositories;
    }
  }
}

async function fetchLanguageTotals(repositories) {
  const totals = new Map();
  const concurrency = 6;

  for (let index = 0; index < repositories.length; index += concurrency) {
    const batch = repositories.slice(index, index + concurrency);
    const responses = await Promise.all(
      batch.map((repository) =>
        githubRequest(
          `/repos/${encodeURIComponent(repository.owner.login)}/${encodeURIComponent(repository.name)}/languages`,
        ),
      ),
    );

    for (const languages of responses) {
      for (const [language, bytes] of Object.entries(languages)) {
        totals.set(language, (totals.get(language) ?? 0) + bytes);
      }
    }
  }

  return [...totals.entries()]
    .map(([name, bytes]) => ({ name, bytes }))
    .sort((left, right) => right.bytes - left.bytes || left.name.localeCompare(right.name));
}

function metricCell({ x, label, value, note }, palette, delayClass) {
  const divider =
    x === 24
      ? ""
      : `<line x1="${x - 12}" y1="61" x2="${x - 12}" y2="116" stroke="${palette.border}" />`;

  return `
    <g class="reveal ${delayClass}">
      ${divider}
      <text x="${x}" y="76" class="label">${escapeXml(label)}</text>
      <text x="${x}" y="101" class="metric-value">${escapeXml(value)}</text>
      <text x="${x}" y="114" class="note">${escapeXml(note)}</text>
    </g>`;
}

function renderLanguageSection(languages, palette) {
  const barX = 24;
  const barY = 148;
  const barWidth = 772;
  const colors = [
    palette.blue,
    palette.purple,
    palette.green,
    palette.orange,
    palette.cyan,
  ];
  const totalBytes = languages.reduce((sum, language) => sum + language.bytes, 0);
  const topLanguages = languages.slice(0, 5);
  let offset = 0;

  const segments = topLanguages
    .map((language, index) => {
      const width =
        totalBytes === 0 ? 0 : (language.bytes / totalBytes) * barWidth;
      const segment = `<rect x="${(barX + offset).toFixed(2)}" y="${barY}" width="${Math.max(0, width).toFixed(2)}" height="8" fill="${colors[index]}" />`;
      offset += width;
      return segment;
    })
    .join("");

  const legend = topLanguages
    .map((language, index) => {
      const x = 25 + index * 154;
      const percentage =
        totalBytes === 0 ? 0 : Math.round((language.bytes / totalBytes) * 100);
      return `
        <circle cx="${x}" cy="174" r="3.5" fill="${colors[index]}" />
        <text x="${x + 9}" y="178" class="legend">${escapeXml(
          `${ellipsize(language.name, 13)} ${percentage}%`,
        )}</text>`;
    })
    .join("");

  const emptyMessage =
    topLanguages.length === 0
      ? `<text x="24" y="178" class="legend">No language data</text>`
      : "";

  return `
    <g class="reveal delay-3">
      <text x="24" y="139" class="label">LANGUAGE DISTRIBUTION · NON-FORK PUBLIC REPOSITORIES</text>
      <rect x="${barX}" y="${barY}" width="${barWidth}" height="8" rx="4" fill="${palette.surface}" />
      <g clip-path="url(#language-bar-clip)">${segments}</g>
      ${legend}
      ${emptyMessage}
    </g>`;
}

function renderSvg(data, theme) {
  const palette = palettes[theme];
  const age = completedYears(data.user.created_at);
  const ageLabel = `${age} ${age === 1 ? "YEAR" : "YEARS"}`;
  const createdYear = new Date(data.user.created_at).getUTCFullYear();
  const latestName = data.latestRepository
    ? ellipsize(data.latestRepository.name, 42)
    : "No public repository activity";
  const latestDate = data.latestRepository?.pushed_at
    ? data.latestRepository.pushed_at.slice(0, 10)
    : "—";
  const ownerLabel = ellipsize(owner.toUpperCase(), 24);
  const description = `${owner}'s public GitHub status: ${ageLabel.toLowerCase()} on GitHub, ${data.ownedRepositoryCount} non-fork public repositories, ${data.totalStars} stars, and ${data.user.followers} followers.`;

  const metrics = [
    {
      x: 24,
      label: "GITHUB AGE",
      value: ageLabel,
      note: `SINCE ${createdYear}`,
    },
    {
      x: 220,
      label: "PUBLIC REPOS",
      value: formatNumber(data.ownedRepositoryCount),
      note: "NON-FORK REPOS",
    },
    {
      x: 416,
      label: "TOTAL STARS",
      value: formatNumber(data.totalStars),
      note: "NON-FORK REPOS",
    },
    {
      x: 612,
      label: "FOLLOWERS",
      value: formatNumber(data.user.followers),
      note: "PUBLIC PROFILE",
    },
  ];

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" role="img" aria-labelledby="profile-status-title profile-status-description">
  <title id="profile-status-title">${escapeXml(owner)} · GitHub system status</title>
  <desc id="profile-status-description">${escapeXml(description)}</desc>
  <defs>
    <clipPath id="language-bar-clip">
      <rect x="24" y="148" width="772" height="8" rx="4" />
    </clipPath>
  </defs>
  <style>
    text {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      fill: ${palette.text};
      text-rendering: geometricPrecision;
    }
    .title {
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.7px;
    }
    .meta {
      fill: ${palette.muted};
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.7px;
    }
    .label {
      fill: ${palette.muted};
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.65px;
    }
    .metric-value {
      font-size: 20px;
      font-weight: 700;
    }
    .note {
      fill: ${palette.muted};
      font-size: 8px;
      letter-spacing: 0.45px;
    }
    .legend {
      fill: ${palette.muted};
      font-size: 10px;
      font-weight: 600;
    }
    .latest {
      font-size: 11px;
      font-weight: 650;
    }
    .reveal {
      animation: reveal 420ms ease-out forwards;
    }
    .delay-1 { animation-delay: 70ms; }
    .delay-2 { animation-delay: 140ms; }
    .delay-3 { animation-delay: 210ms; }
    .pulse {
      transform-origin: 25px 27px;
      animation: pulse 2.8s ease-in-out infinite;
    }
    @keyframes reveal {
      from { opacity: 0; transform: translateY(3px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes pulse {
      0%, 100% { opacity: 0.55; transform: scale(0.82); }
      50% { opacity: 1; transform: scale(1); }
    }
    @media (prefers-reduced-motion: reduce) {
      .reveal, .pulse {
        animation: none !important;
        opacity: 1;
        transform: none;
      }
    }
  </style>

  <rect x="0.5" y="0.5" width="819" height="219" rx="7.5" fill="${palette.background}" stroke="${palette.border}" />

  <g class="reveal delay-1">
    <circle class="pulse" cx="25" cy="27" r="4" fill="${palette.green}" />
    <text x="40" y="31" class="title">${escapeXml(ownerLabel)} / SYSTEM STATUS</text>
    <text x="638" y="30" class="meta">PUBLIC GITHUB TELEMETRY</text>
    <line x1="24" y1="43.5" x2="796" y2="43.5" stroke="${palette.border}" />
  </g>

  ${metrics
    .map((metric, index) =>
      metricCell(metric, palette, `delay-${Math.min(index, 2) + 1}`),
    )
    .join("")}

  ${renderLanguageSection(data.languages, palette)}

  <g class="reveal delay-3">
    <line x1="24" y1="190.5" x2="796" y2="190.5" stroke="${palette.border}" />
    <text x="24" y="208" class="label">LATEST PUSH</text>
    <circle cx="116" cy="204" r="3" fill="${palette.blue}" />
    <text x="127" y="208" class="latest">${escapeXml(latestName)}</text>
    <text x="732" y="208" class="meta">${escapeXml(latestDate)}</text>
  </g>
</svg>
`;
}

async function writeAtomically(filename, contents) {
  const destination = path.join(outputDirectory, filename);
  const temporary = `${destination}.tmp`;
  const normalized = contents.replace(/[ \t]+$/gm, "");
  await writeFile(temporary, normalized, "utf8");
  await rename(temporary, destination);
}

async function main() {
  const [user, repositories] = await Promise.all([
    githubRequest(`/users/${encodeURIComponent(owner)}`),
    fetchPublicRepositories(owner),
  ]);
  const nonForkRepositories = repositories.filter(
    (repository) => !repository.fork,
  );
  const portfolioRepositories = nonForkRepositories.filter(
    (repository) => repository.name.toLowerCase() !== owner.toLowerCase(),
  );
  const languages = await fetchLanguageTotals(portfolioRepositories);
  const latestRepository =
    [...portfolioRepositories].sort(
      (left, right) =>
        new Date(right.pushed_at) - new Date(left.pushed_at) ||
        left.full_name.localeCompare(right.full_name),
    )[0] ?? null;
  const totalStars = nonForkRepositories.reduce(
    (sum, repository) => sum + repository.stargazers_count,
    0,
  );
  const data = {
    user,
    languages,
    latestRepository,
    ownedRepositoryCount: nonForkRepositories.length,
    totalStars,
  };
  const light = renderSvg(data, "light");
  const dark = renderSvg(data, "dark");

  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeAtomically("profile-status-light.svg", light),
    writeAtomically("profile-status-dark.svg", dark),
  ]);

  process.stdout.write(
    `Generated profile status SVGs for ${owner} in ${outputDirectory}\n`,
  );
}

await main();
