import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IntlMessageFormat } from "intl-messageformat";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(__dirname, "../app");
const localesDir = path.join(appDir, "locales");

function readCatalog(lang) {
  const filePath = path.join(localesDir, lang, "app.json");
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing locale file: ${filePath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Locale ${lang}/app.json must be a JSON object`);
  }
  return parsed;
}

function collectTsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const en = readCatalog("en");
const bn = readCatalog("bn");
const template = readCatalog("TEMPLATE");

const enKeys = Object.keys(en).sort();
const bnKeys = Object.keys(bn).sort();
const templateKeys = Object.keys(template).sort();

const errors = [];

for (const key of enKeys) {
  if (typeof en[key] !== "string" || en[key].trim().length === 0) {
    errors.push(`en.${key}: must be a non-empty string`);
  } else {
    try {
      new IntlMessageFormat(en[key], "en");
    } catch (err) {
      errors.push(`en.${key}: invalid ICU message (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  if (!Object.hasOwn(bn, key)) {
    errors.push(`bn: missing key "${key}"`);
  } else if (typeof bn[key] !== "string" || !bn[key].startsWith("TODO: ")) {
    errors.push(`bn.${key}: must start with "TODO: "`);
  } else {
    try {
      new IntlMessageFormat(bn[key], "bn");
    } catch (err) {
      errors.push(`bn.${key}: invalid ICU message (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  if (!Object.hasOwn(template, key)) {
    errors.push(`TEMPLATE: missing key "${key}"`);
  } else if (template[key] !== "") {
    errors.push(`TEMPLATE.${key}: must be empty string ""`);
  }
}

for (const key of bnKeys) {
  if (!Object.hasOwn(en, key)) {
    errors.push(`bn: extra key "${key}" not in en`);
  }
}

for (const key of templateKeys) {
  if (!Object.hasOwn(en, key)) {
    errors.push(`TEMPLATE: extra key "${key}" not in en`);
  }
}

const srcFiles = collectTsFiles(path.join(appDir, "src"));
const keyRefRe = /\bt\(\s*"([^"]+)"/g;
for (const file of srcFiles) {
  const text = fs.readFileSync(file, "utf8");
  for (const match of text.matchAll(keyRefRe)) {
    const key = match[1];
    if (!Object.hasOwn(en, key)) {
      errors.push(`${path.relative(appDir, file)}: references unknown i18n key "${key}"`);
    }
  }
}

if (errors.length > 0) {
  console.error("i18n check failed:");
  for (const err of errors) {
    console.error(`  - ${err}`);
  }
  process.exit(1);
}

console.log(`i18n check passed (${enKeys.length} keys across en, bn, TEMPLATE).`);
