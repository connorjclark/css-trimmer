const fs = require('fs');
const { spawnSync } = require('child_process');

/**
 * @param {string} name
 * @param {string[]} args
 */
function defineTest(name, args) {
  it(`snapshot ${name}`, async () => {
    const {stdout, stderr} = spawnSync('node', [
      `${__dirname}/../src/cli.js`,
      ...args,
      '--output=json',
      '--quiet',
      '--debug',
    ]);
    const json = stdout.toString();
    if (stderr.toString()) console.log(stderr.toString());

    /** @type {import('../src/css-trimmer.js').Report} */
    const report = JSON.parse(json);

    expect(report.output.replace(__dirname, '...')).toMatchSnapshot();

    if (name === '/fixtures/lh') return;
    if (name.includes('http')) return;

    const numExpectedUnused = report.styleSheets
      .map(styleSheet => (styleSheet.content.match(/unused!/g) || []).length)
      .reduce((acc, cur) => acc + cur, 0);

    expect(report.unusedDeclarationCount).toBe(numExpectedUnused);
  });
}

for (const name of fs.readdirSync(__dirname + '/fixtures')) {
  const dir = `test/fixtures/${name}`;
  const configPath = `${dir}/config.js`;
  const htmlFiles = fs
    .readdirSync(dir)
    .filter(file => file.endsWith('.html'))
    .map(file => `${dir}/${file}`);

  const args = [
    '--disable-default-config',
    ...htmlFiles,
  ];
  if (fs.existsSync(configPath)) args.push(`--config-path=${configPath}`);
  defineTest(`/fixtures/${name}`, args);
}

defineTest('https://www.example.com', [
  'https://www.example.com',
]);
