// Release builds (the release pipeline and the Docker apps build): the update feed, DOWNLOADS_URL,
// is written into the app and into latest.yml / latest-linux.yml. Windows builds are signed: on
// Windows with Artifact Signing, elsewhere with jsign when the build sets its options (unsigned
// without).
if (!process.env.DOWNLOADS_URL) throw new Error('Release builds need DOWNLOADS_URL');

const base =
  process.platform === 'win32'
    ? require('./electron-builder.signed.cjs')
    : process.env.JSIGN_OPTIONS_FILE
      ? require('./electron-builder.jsign.cjs')
      : { extends: 'electron-builder.yml' };

module.exports = {
  ...base,
  publish: { provider: 'generic', url: process.env.DOWNLOADS_URL },
  // Each stage has its own feed, so prerelease versions (1.2.3-rc.1) keep latest*.yml rather
  // than a channel's (rc-linux.yml).
  detectUpdateChannel: false,
};
