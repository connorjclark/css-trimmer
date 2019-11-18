/** @type {import('../../../src/css-trimmer.js').Options} */
module.exports = {
  afterNavigation: async (context) => {
    await context.current.page.evaluate(() => {
      // document.querySelector('main').classList.add('score100');

      // @ts-ignore
      // TODO: do this sometimes
      document.querySelector('.lh-tools__button').click();
    });
  },
  onlyCollections: [
    'test/fixtures/lh/report-1.html viewport 500,500',
    'test/fixtures/lh/report-6.html viewport 500,500',
    'test/fixtures/lh/report-6.html initial',
    'test/fixtures/lh/report-2.html initial',
  ],
  viewports: [{ width: 500, height: 500 }],
};
