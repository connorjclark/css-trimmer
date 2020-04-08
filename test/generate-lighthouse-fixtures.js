const fs = require('fs');
const ReportGenerator = require('lighthouse/lighthouse-core/report/report-generator.js');

const files = fs.readdirSync(process.argv[2])
  .map(file => process.argv[2] + '/' + file)
  .slice(0, 10);

for (const [i, file] of Object.entries(files)) {
  const lhr = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const report = ReportGenerator.generateReportHtml(lhr);
  fs.writeFileSync(`${__dirname}/fixtures/lh/report-${Number(i) + 1}.html`, report);
}

// node src/cli.js test/fixtures/lh/*.html --viewports=500,500 --color-scheme=dark --debug
