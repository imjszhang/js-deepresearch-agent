#!/usr/bin/env node
import './config/bootstrap-env.mjs';
import { createServices } from './bootstrap.mjs';
import { createApp } from './api/app.mjs';
import { getDb } from './storage/db.mjs';
import {
  ResearchCancelledError,
  runCliResearch,
} from './cli-research-run.mjs';
import {
  applyResearchFlags,
  formatHistory,
  getDeepValue,
  parseArgs,
  setDeepValue,
} from './cli-utils.mjs';

const services = createServices(getDb());

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = error instanceof ResearchCancelledError ? 130 : 1;
});

async function main(argv) {
  const command = argv[0];
  const rest = argv.slice(1);

  if (!command || command === 'help' || command === '--help') {
    printHelp();
    return;
  }

  if (command === 'research') {
    await researchCommand(rest);
    return;
  }

  if (command === 'config') {
    configCommand(rest);
    return;
  }

  if (command === 'history') {
    historyCommand(rest);
    return;
  }

  if (command === 'serve') {
    serveCommand(rest);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

async function researchCommand(argv) {
  const { args, flags } = parseArgs(argv);
  const query = args.join(' ').trim();
  if (!query) throw new Error('Usage: js-deepresearch-agent research "query"');

  const settings = settingsFromFlags(flags);
  const { result, artifacts } = await runCliResearch({
    query,
    settings,
    flags,
    services,
  });

  if (flags.json) {
    console.log(JSON.stringify({ ...result, artifacts }, null, 2));
  } else {
    console.log(result.report);
  }
}

function configCommand(argv) {
  const [subcommand, key, ...valueParts] = argv;
  const settings = services.settingsStore.get();

  if (!subcommand || subcommand === 'get') {
    const value = key ? getDeepValue(settings, key) : settings;
    console.log(JSON.stringify(value, null, 2));
    return;
  }

  if (subcommand === 'set') {
    if (!key || valueParts.length === 0) {
      throw new Error('Usage: js-deepresearch-agent config set <key> <value>');
    }
    const updated = setDeepValue(settings, key, valueParts.join(' '));
    services.settingsStore.save(updated);
    console.log(`${key} updated.`);
    return;
  }

  throw new Error(`Unknown config command: ${subcommand}`);
}

function historyCommand(argv) {
  const [subcommand, id] = argv;
  if (!subcommand || subcommand === 'list') {
    console.log(formatHistory(services.researchRepository.list()));
    return;
  }

  if (subcommand === 'show') {
    const record = services.researchRepository.get(id);
    if (!record) throw new Error(`Research not found: ${id}`);
    console.log(record.report || record.error || 'No report available.');
    return;
  }

  throw new Error(`Unknown history command: ${subcommand}`);
}

function serveCommand(argv) {
  const { flags } = parseArgs(argv);
  const port = Number(flags.port || process.env.PORT || 3000);
  const app = createApp(getDb());
  app.listen(port, () => {
    console.log(`js-deepresearch-agent listening on http://127.0.0.1:${port}`);
  });
}

function settingsFromFlags(flags) {
  return applyResearchFlags(services.settingsStore.get(), flags);
}

function printHelp() {
  console.log(`
js-deepresearch-agent

Commands:
  research "query" [--search js-eyes|searxng] [--search-skills skillA,skillB] [--js-eyes-skill skillA,skillB] [--search-server-url ws://localhost:18080] [--search-base-url http://127.0.0.1:8080] [--strategy source-based|rapid|parallel] [--iterations 2] [--questions 3] [--concurrency 2] [--work-dir work_dir] [--output report.md] [--json] [--no-save] [--no-work-dir]
    Press Ctrl+C once to cancel gracefully; press again to force exit.
  config get [key]
  config set <key> <value>
  history [list]
  history show <researchId>
  serve [--port 3000]
`);
}
