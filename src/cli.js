#!/usr/bin/env node

const path = require('path');
const yargs = require('yargs');
const cssTrimmer = require('./css-trimmer.js');

/** @typedef {import('./css-trimmer.js').Options} Options */

/** @type {any} */
const argv = yargs
  .usage('css-trimmer [urlsOrFiles] <options>')
  .usage('css-trimmer path/to/page.html path/to/page2.html --viewports 500,500')
  .usage('css-trimmer https://www.example.com')

  .describe({
    'color-scheme': 'Add a collection while emulating `prefers-color-scheme` to the value given',
    'config-path': 'Loads these options from disk. Supports .js and .json',
    'debug': 'Generate debug data, such as which collections were redundant',
    'disable-default-config': 'Disable loading of the default configuration',
    'only-collections': 'Collections to process - all others are skipped',
    'output': 'Format for the generated the report',
    'quiet': 'Suppress logging output to stderr',
    'skip-collections': 'Collections to skip - all others are processed',
    'viewports': 'viewports "width,height". Adds a collection while emulate each viewport.',
  })

  .boolean([
    'debug',
    'disable-default-config',
    'quiet',
  ])
  .array([
    'only-collections',
    'skip-collections',
    'viewports',
  ])
  .string([
    'color-scheme',
    'config-path',
  ])

  .choices('output', ['json', 'text'])

  .default('output', 'text')
  .default('quiet', false)

  .argv;

/**
 * @param {any} target
 * @param {any} config
 */
function mergeConfigInto(target, config) {
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined) continue;

    if (Array.isArray(target[key])) {
      target[key].push(...value);
    } else {
      target[key] = value;
    }
  }

  return target;
}

async function main() {
  /** @type {Options} */
  let options = {};

  const configPath = argv.configPath || !argv.disableDefaultConfig && (__dirname + '/default-config');
  if (configPath) {
    if (configPath) {
      options = require(path.resolve(configPath));
    } else {
      throw new Error('unexpected config path');
    }
  }

  /** @type {Options} */
  let cliOptions = {
    colorScheme: argv.colorScheme,
    debug: argv.debug,
    onlyCollections: argv.onlyCollections,
    skipCollections: argv.skipCollections,
    quiet: argv.quiet,
    viewports: argv.viewports && argv.viewports.map(/** @param {string} viewport */(viewport) => {
      const [width, height] = viewport.split(',').map((n) => parseInt(n, 10));
      return { width, height };
    }),
  };

  mergeConfigInto(options, cliOptions);
  const report = await cssTrimmer.run(argv._, options);

  if (argv.output === 'text') {
    console.log(report.output);
  } else {
    console.log(JSON.stringify(report, null, 2));
  }

  // Avoid the annoying stdout truncation on process exit.
  setTimeout(() => process.exit(report.output ? 1 : 0), 10);
}

main();
