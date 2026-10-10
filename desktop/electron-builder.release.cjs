// Release builds (the release pipeline): the stage's update feed, DOWNLOADS_URL, is written into
// the app and into latest.yml / latest-linux.yml. On Windows the build is also signed.
if (!process.env.DOWNLOADS_URL) throw new Error('Release builds need DOWNLOADS_URL');

const base =
  process.platform === 'win32'
    ? require('./electron-builder.signed.cjs')
    : { extends: 'electron-builder.yml' };

module.exports = {
  ...base,
  publish: { provider: 'generic', url: process.env.DOWNLOADS_URL },
};
