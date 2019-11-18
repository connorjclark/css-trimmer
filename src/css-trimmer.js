const path = require('path');
const puppeteer = require('puppeteer');
const css = require('css');

/** @typedef {import('puppeteer').Browser} Browser */
/** @typedef {import('puppeteer').Page} Page */
/** @typedef {Crdp.Protocol.CSS.CSSStyleSheetHeader} ProtocolStyleSheet */
/** @typedef {Crdp.Protocol.CSS.CSSProperty} ProtocolCSSProperty */

/**
 * @typedef Options
 * @property {boolean=} debug
 * @property {string=} colorScheme
 * @property {Array<{width: number, height: number}>=} viewports
 * @property {string[]=} onlyCollections
 * @property {string[]=} skipCollections
 * @property {boolean=} quiet
 *
 * @property {function(Context):void=} afterNavigation
 */

/**
 * @typedef Context
 * @property {Browser} browser
 * @property {Collection[]} collections
 * @property {CurrentContext} current
 * @property {Options} options
 * @property {string[]} warnings
 * @property {function(...string): void} log
 * @property {function(string): Promise<void>} navigate
 * @property {function(string): Promise<void>} collect
 * @property {function(): Report} finish
 */

/**
 * @typedef CurrentContext
 * @property {Page} page
 * @property {CDPSession} client
 * @property {Map<string, ProtocolStyleSheet>} styleSheetMap
 */

/**
 * @typedef Collection
 * @property {string} name
 * @property {CollectionEntry[]} entries
 */

/**
 * @typedef {{styleSheet: ProtocolStyleSheet, content: string, usedRanges: Set<string>}} CollectionEntry
 */

/**
 * @typedef Report
 * @property {DebugInfo=} debug
 * @property {Array<any>} styleSheets
 * @property {string} output
 * @property {string[]} warnings
 * @property {number} unusedDeclarationCount
 */

/**
 * @typedef DebugInfo
 * @property {string[]} collectionNames
 * @property {number[]} incrementalCoverage
 * @property {string[]} minimalCollectionNames
 * @property {number[]} usedRangeCounts
 */

/**
 * @param {number[]} arr
 */
function sum(arr) {
  return arr.reduce((acc, cur) => acc + cur, 0);
}

/**
 * Helps dedupe styleSheets across page loads.
 * @param {CollectionEntry[]} entries
 * @param {ProtocolStyleSheet} styleSheet
 */
function findOrMakeCollectionEntry(entries, styleSheet) {
  const entry = findCollectionEntry(entries, styleSheet);
  if (entry) return entry;

  const newEntry = { styleSheet, content: '', usedRanges: new Set() };
  entries.push(newEntry);
  return newEntry;
}

/**
 * @param {CollectionEntry[]} entries
 * @param {ProtocolStyleSheet} styleSheet
 */
function findCollectionEntry(entries, styleSheet) {
  for (const entry of entries) {
    // The same id is obviously the same style sheet.
    if (styleSheet.styleSheetId === entry.styleSheet.styleSheetId) {
      return entry;
    }

    // Dito for the URL.
    if (styleSheet.sourceURL && !styleSheet.isInline && entry.styleSheet.sourceURL === styleSheet.sourceURL) {
      return entry;
    }
  }

  // Style sheets of the same length are probably the same styles.
  // Could just check if the content is the same, but that is expensive over the protocol.
  const potentialEntries = entries.filter(entry => entry.styleSheet.length === styleSheet.length);
  if (potentialEntries.length === 1) return potentialEntries[0];
  if (potentialEntries.length > 1) {
    console.warn('found multiple potential styles for', styleSheet);
  }

  return null;
}

/**
 * @param {any} o
 */
function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

/**
 * @param {Collection[]} collections
 * @return {Collection}
 */
function combineCollections(collections) {
  /** @type {Collection} */
  const combined = {
    name: 'combined',
    entries: [],
  };

  for (const collection of collections) {
    for (const entry of collection.entries) {
      const combinedEntry = findCollectionEntry(combined.entries, entry.styleSheet);
      if (combinedEntry) {
        entry.usedRanges.forEach(range => combinedEntry.usedRanges.add(clone(range)));
      } else {
        combined.entries.push({
          styleSheet: entry.styleSheet,
          content: entry.content,
          usedRanges: new Set(entry.usedRanges),
        });
      }
    }
  }

  return combined;
}

/** @typedef {ProtocolCSSProperty & {range: Crdp.Protocol.CSS.SourceRange, disabled: false}} ValidProtocolCSSProperty */

/**
 * @param {ProtocolCSSProperty} property
 * @return {property is ValidProtocolCSSProperty}
 */
function isValidProperty(property) {
  // No range means this is an expanded style (authored css uses `border`, but makes
  // `border-top-width`, `border-right-width`, etc...)
  if (!property.range) return false;
  // Ignore declarations that are wrapped in comment blocks.
  if (property.disabled) return false;
  // TODO: check if variables are used.
  if (property.name.startsWith('--')) return false;

  return true;
}

/**
 * @param {any} data
 */
function findActiveStyles(data) {
  /** @type {Map<string, {property: ValidProtocolCSSProperty, rule: any}|null>} */
  const propertyToRule = new Map();

  for (const property of data.inlineStyle.cssProperties) {
    if (property.disabled) continue;
    propertyToRule.set(property.name, null);
  }

  for (let i = data.matchedCSSRules.length - 1; i >= 0; i--) {
    // TODO: do something with matchedSelectors?
    const rule = data.matchedCSSRules[i].rule;
    for (const property of rule.style.cssProperties) {
      if (!isValidProperty(property)) continue;
      // Been there, done that.
      if (propertyToRule.has(property.name)) continue;

      propertyToRule.set(property.name, {
        property,
        rule,
      });
    }
  }

  return propertyToRule;
}

/**
 * @param {Options} options
 * @return {Promise<Context>}
 */
async function start(options) {
  /** @type {Context} */
  const context = {
    browser: await puppeteer.launch(),
    collections: [],
    // @ts-ignore: This is set later.
    current: null,
    options,
    warnings: [],
    /** @param {...string} args */
    log(...args) {
      if (!options.quiet) console.warn('INFO:', ...args);
    },
    /** @param {string} url */
    navigate(url) { return navigate(url, context) },
    /** @param {string} name */
    collect(name) { return collect(name, context) },
    finish() { return finish(context) },
  };
  return context;
}

/**
 * @param {string} url
 * @param {Context} context
 */
async function navigate(url, context) {
  if (context.current) {
    await context.current.page.close();
  }

  const page = await context.browser.newPage();
  const client = /** @type {CDPSession} */ (await page.target().createCDPSession());
  await client.send('DOM.enable');
  await client.send('CSS.enable');

  const styleSheetMap = new Map();
  client.on('CSS.styleSheetAdded', styleSheetData => {
    styleSheetMap.set(styleSheetData.header.styleSheetId, styleSheetData.header);
  });

  await page.goto(url);

  context.current = {
    page,
    client,
    styleSheetMap,
  };

  if (context.options.afterNavigation) {
    await context.options.afterNavigation(context);
  }
}

/**
 * @param {Context} context
 */
async function getNodes(context) {
  const { current } = context;

  const flattenedDocument = await current.client.send('DOM.getFlattenedDocument', { depth: -1 });
  const ignoreElements = [
    'circle',
    'defs',
    'g',
    'HEAD',
    'HTML',
    'linearGradient',
    'LINK',
    'META',
    'NOSCRIPT',
    'path',
    'rect',
    'SCRIPT',
    'stop',
    'STYLE',
    'svg',
    'TEMPLATE',
    'TITLE',
    'use',
  ];

  return flattenedDocument.nodes
    .filter(node => node.nodeType === 1 && !ignoreElements.includes(node.nodeName));
}

/**
 * @param {string} name
 * @param {Context} context
 */
function shouldSkip(name, context) {
  if (context.options.onlyCollections) {
    if (!context.options.onlyCollections.includes(name)) {
      context.log('skipping', name);
      return true;
    }
  } else if (context.options.skipCollections) {
    if (context.options.skipCollections.includes(name)) {
      context.log('skipping', name);
      return true;
    }
  }

  return false;
}

/**
 * @param {string} name
 * @param {Context} context
 */
async function collect(name, context) {
  // TODO: is this needed? the CLI runner skips in a different way.
  if (shouldSkip(name, context)) {
    return;
  }

  const { current } = context;

  // @ts-ignore
  const nodes = await getNodes(context);

  // TODO: make a super selector of all the CSS rules, and only grab those Nodes.
  // const body = nodes.find(n => n.nodeName === 'BODY');
  // const d = await current.client.send('DOM.querySelectorAll', {nodeId: body.nodeId, selector: '.crc-node,span.lh-env__name'});
  // console.log(d);

  /** @type {Collection} */
  const collection = {
    name,
    entries: [],
  };

  /**
   * @param {any} rule
   * @param {ValidProtocolCSSProperty} property
   */
  function processActiveProperty(rule, property) {
    if (rule.origin === 'user-agent') return;

    const id = rule.styleSheetId;
    const styleSheet = current.styleSheetMap.get(id);
    if (!styleSheet) throw new Error('shouldnt happen');
    const collectionEntry = findOrMakeCollectionEntry(collection.entries, styleSheet);
    const range = property.range;
    collectionEntry.usedRanges.add(`${range.startLine},${range.startColumn},${range.endLine},${range.endColumn}`);
  }

  await Promise.all(nodes.map(async ({ nodeId, nodeName }) => {
    const matchedStyles = await current.client.send('CSS.getMatchedStylesForNode', { nodeId });
    const activeStyles = findActiveStyles(matchedStyles);

    if (!activeStyles) {
      // TODO: understand this case.
      context.warnings.push(`could not find styles ${nodeId}`);
      return;
    }

    for (const [key, value] of activeStyles.entries()) {
      if (!value) {
        // TODO: understand this case.
        context.warnings.push(`null value in activeStyles ${key}`);
        continue;
      }

      const { rule, property } = value;
      processActiveProperty(rule, property);
    }

    // Handle pseudo elements.
    if (matchedStyles.pseudoElements) {
      for (const { matches } of matchedStyles.pseudoElements) {
        for (const { rule } of matches) {
          for (const property of rule.style.cssProperties) {
            if (!isValidProperty(property)) continue;
            processActiveProperty(rule, property);
          }
        }
      }
    }
  }));

  for (const entry of collection.entries) {
    if (entry.content) continue;
    const data = await current.client.send('CSS.getStyleSheetText', {
      styleSheetId: entry.styleSheet.styleSheetId,
    });
    entry.content = data.text;
  }

  context.collections.push(collection);
}

/**
 * @param {Collection} collection
 */
function getResults(collection) {
  const resultsByStyleSheets = [];
  for (const entry of collection.entries) {
    /** @type {any[]} */ // TODO
    const rules = [];
    const ast = css.parse(entry.content);

    /**
     * @param {css.Rule & css.Media} rule
     */
    function process(rule) {
      if (rule.type === 'media' && rule.rules) {
        rule.rules.forEach(process);
        return;
      }

      if (rule.type !== 'rule' || !rule.declarations) {
        return;
      }

      const unusedDeclarations = rule.declarations
        .map(declaration => {
          if (declaration.type !== 'declaration') return;
          // css types don't use type discrimination, so still need to disable checker :(

          const p = declaration.position;
          // @ts-ignore: can these even be undefined?
          const isUsed = entry.usedRanges.has(`${p.start.line - 1},${p.start.column - 1},${p.end.line - 1},${p.end.column}`);
          if (isUsed) return;

          // TODO: check if variables are used.
          // @ts-ignore: this isn't a comment
          if (declaration.property.startsWith('--')) return;

          return {
            // @ts-ignore: this isn't a comment
            property: declaration.property,
            // @ts-ignore: this isn't a comment
            value: declaration.value,
            position: declaration.position,
          };
        }).filter(Boolean);

      if (!unusedDeclarations.length) return;

      // TODO: the typing here is really annoying so let's skip a lot

      const position = {
        // @ts-ignore
        start: { ...rule.position.start },
        // @ts-ignore
        end: { ...rule.position.end },
      };

      // Use zero-based indices.
      // @ts-ignore
      position.start.line -= 1;
      // @ts-ignore
      position.start.column -= 1;
      // @ts-ignore
      position.end.line -= 1;
      // @ts-ignore
      position.end.column -= 1;
      // @ts-ignore
      for (const d of unusedDeclarations) {
        // @ts-ignore
        d.position.start.line -= 1;
        // @ts-ignore
        d.position.start.column -= 1;
        // @ts-ignore
        d.position.end.line -= 1;
        // @ts-ignore
        d.position.end.column -= 1;
      }

      // if (styleSheet.isInline) {
      //   position.start.line += styleSheet.startLine;
      //   position.end.line += styleSheet.startLine;
      //   for (const d of unusedDeclarations) {
      //     d.position.start.line += styleSheet.startLine;
      //     d.position.end.line += styleSheet.startLine;
      //   }
      //   // TODO column
      // }

      rules.push({
        selectors: rule.selectors,
        unusedDeclarations,
        position,
      });
    }

    if (!ast.stylesheet) throw new Error('bad ast');

    for (const rule of ast.stylesheet.rules) {
      process(rule);
    }

    const unusedDeclarationCount = sum(rules.map(r => r.unusedDeclarations.length));

    resultsByStyleSheets.push({
      url: entry.styleSheet.sourceURL,
      isInline: entry.styleSheet.isInline,
      startLine: entry.styleSheet.startLine,
      startColumn: entry.styleSheet.startColumn,
      content: entry.content,
      rules,
      unusedDeclarationCount,
    });
  }

  return resultsByStyleSheets;
}

/**
 * This is a greedy approach, but it's better than nothing.
 * @param {Context} context
 */
function findMinimalCollections(context) {
  const combined = combineCollections(context.collections);

  // Add a collection by most unique used range.
  /** @type {Map<string, number>} index + range => count */
  const usedRangeCount = new Map();
  for (let i = 0; i < combined.entries.length; i++) {
    const canonicalEntry = combined.entries[i];
    for (const collection of context.collections) {
      const collectionEntry = findCollectionEntry(collection.entries, canonicalEntry.styleSheet);
      if (!collectionEntry) continue;

      for (const range of collectionEntry.usedRanges) {
        const key = `${i}-${range}`;
        usedRangeCount.set(key, (usedRangeCount.get(key) || 0) + 1);
      }
    }
  }

  const remainingCollections = [...context.collections];
  const minimalCollections = [];
  while (usedRangeCount.size) {
    const smallestKey = [...usedRangeCount.entries()]
      .reduce((min, [key, count]) => min[1] > count ? [key, count] : min)[0];
    const [index, range] = smallestKey.split('-');

    const canonicalEntry = combined.entries[Number(index)];
    const nextCollectionIndex = remainingCollections.findIndex(collection => {
      const entry = findCollectionEntry(collection.entries, canonicalEntry.styleSheet);
      return entry && entry.usedRanges.has(range);
    });
    if (nextCollectionIndex === -1) throw new Error('expected to find a nextCollection');
    const nextCollection = remainingCollections[nextCollectionIndex];
    minimalCollections.push(nextCollection);
    remainingCollections.splice(nextCollectionIndex, 1);

    // Delete the used counts.
    for (let i = 0; i < combined.entries.length; i++) {
      const canonicalEntry = combined.entries[i];
      const collectionEntry = findCollectionEntry(nextCollection.entries, canonicalEntry.styleSheet);
      if (!collectionEntry) continue;

      for (const range of collectionEntry.usedRanges) {
        const key = `${i}-${range}`;
        usedRangeCount.delete(key);
      }
    }
  }

  return minimalCollections;
}

/**
 * @param {Report} report
 */
function makeTextOutput(report) {
  const { styleSheets } = report;
  const totalUnusedDeclarationCount = sum(styleSheets.map(r => r.unusedDeclarationCount));

  let output = styleSheets.map(result => {
    const contentLines = result.content.split('\n');
    const outputLines = [];

    outputLines.push('=========');
    outputLines.push((result.url || 'unknown') + ` (${result.unusedDeclarationCount} unused declarations)`);
    outputLines.push('=========');

    for (const rule of result.rules) {
      for (const declaration of rule.unusedDeclarations) {
        let linenum = declaration.position.start.line;
        const lineContent = contentLines[linenum].trim();
        if (result.isInline) linenum += result.startLine;
        outputLines.push(`:${linenum + 1} ${rule.selectors[0]} { ${lineContent} }`);
      }
    }

    return outputLines.join('\n');
  }).filter(Boolean).join('\n\n') + `\n\n-----\ntotal unused declarations: ${totalUnusedDeclarationCount}`;

  if (report.debug) {
    const lines = ['\n\n=========\nDEBUG\n========='];

    lines.push('\n- collections\n');
    for (const name of report.debug.collectionNames) {
      lines.push(name);
    }

    lines.push('\n- incremental coverage\n');
    for (const [i, n] of Object.entries(report.debug.incrementalCoverage)) {
      const name = report.debug.collectionNames[Number(i)];
      lines.push(`unusedDeclarationCount ${n} ${name}`);
    }

    lines.push('\n- used ranges count\n');
    for (const [i, n] of Object.entries(report.debug.usedRangeCounts)) {
      const name = report.debug.collectionNames[Number(i)];
      lines.push(`used ranges ${n} ${name}`);
    }

    if (report.debug.minimalCollectionNames.length !== report.debug.collectionNames.length) {
      lines.push('\n- minimal collections\n');
      for (const name of report.debug.minimalCollectionNames) {
        lines.push(name);
      }

      const notInMinimal = report.debug.collectionNames
        .filter(name => report.debug && !report.debug.minimalCollectionNames.includes(name));
      lines.push('\n- not in minimal\n');
      lines.push(...notInMinimal);
      lines.push('\nto run just the minimal collections, use:');
      lines.push('--only-collections ' + report.debug.minimalCollectionNames.map(n => `'${n}'`).join(' '));
    }

    output += lines.join('\n');
  }

  if (report.warnings.length) {
    output += '\n- warnings\n' + report.warnings.join('\n');
  }

  return output;
}

/**
 * @param {Context} context
 */
function finish(context) {
  context.browser.close();

  const combined = combineCollections(context.collections);
  const resultsByStyleSheets = getResults(combined);
  /** @type {Report} */
  const report = {
    output: '',
    styleSheets: resultsByStyleSheets,
    unusedDeclarationCount: sum(resultsByStyleSheets.map(r => r.unusedDeclarationCount)),
    warnings: [],
  };

  if (context.options.debug) {
    /** @type {Collection} */
    let combined = {
      name: '',
      entries: [],
    };
    const incrementalCoverage = [];
    for (const nextCollection of context.collections) {
      combined = combineCollections([combined, nextCollection]);
      const partialReport = getResults(combined);
      const partialCount = sum(partialReport.map(r => r.unusedDeclarationCount));
      incrementalCoverage.push(partialCount);
    }

    const usedRangeCounts = context.collections
      .map(collection => sum(collection.entries.map(e => e.usedRanges.size)));

    const minimalCollections = findMinimalCollections(context);
    const minimalCollectionNames = minimalCollections.map(c => c.name);

    report.debug = {
      collectionNames: context.collections.map(c => c.name),
      incrementalCoverage,
      minimalCollectionNames,
      usedRangeCounts,
    };
  }

  report.output = makeTextOutput(report);
  return report;
}

/**
 * @param {string[]} urlOrFiles
 * @param {Options} options
 */
async function run(urlOrFiles, options) {
  const context = await start(options);

  const jobs = [];
  for (const urlOrFile of urlOrFiles) {
    /** @type {Array<{name: string, colorScheme?: string, viewport?: {width: number, height: number}}>} */
    const tasks = [];

    const isUrl = /^.*:\/\//.test(urlOrFile);
    const url = isUrl ? urlOrFile : 'file://' + path.resolve(urlOrFile);
    const name = urlOrFile;

    tasks.push({
      name: `${name} initial`,
    });

    if (options.colorScheme) {
      tasks.push({
        name: `${name} colorScheme ${options.colorScheme}`,
        colorScheme: options.colorScheme,
      });
    }

    if (options.viewports) {
      tasks.push(...options.viewports.map(viewport => {
        return {
          name: `${name} viewport ${viewport.width},${viewport.height}`,
          viewport,
        };
      }));
    }

    jobs.push({
      url,
      tasks,
    });
  }

  for (const job of jobs) {
    const tasks = job.tasks.filter(task => !shouldSkip(task.name, context));
    if (!tasks.length) continue;

    await context.navigate(job.url);
    for (const task of tasks) {
      context.log('collect', task.name);

      if (task.colorScheme) {
        // @ts-ignore
        await context.current.page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: task.colorScheme }]);
        // TODO: how to disable?
      }

      if (task.viewport) {
        // TODO: allow for reload here.
        await context.current.page.emulate({
          viewport: task.viewport,
          userAgent: '', // TODO: puppeteer says this is optional
        });
      }

      await context.collect(task.name);
      await context.current.page.emulateMedia(null);
    }
  }

  return context.finish();
}

module.exports = {
  run,
  start,
};
