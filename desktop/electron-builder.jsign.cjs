// Windows build signed off Windows (the Docker apps build, docker/apps-build.sh): electron-builder.yml
// plus a sign hook that runs jsign (JSIGN_JAR) with the options in JSIGN_OPTIONS_FILE, one per
// line: a certificate file or Artifact Signing, whose secrets jsign reads from files (`file:`).
// Updates must carry WIN_PUBLISHER_NAME, the certificate's CN.
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');

const required = ['JSIGN_JAR', 'JSIGN_OPTIONS_FILE', 'WIN_PUBLISHER_NAME'];
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) throw new Error(`Signing with jsign needs ${missing.join(', ')}`);

const options = readFileSync(process.env.JSIGN_OPTIONS_FILE, 'utf8').split('\n').filter(Boolean);

module.exports = {
  extends: 'electron-builder.yml',
  win: {
    signtoolOptions: {
      publisherName: process.env.WIN_PUBLISHER_NAME,
      signingHashAlgorithms: ['sha256'],
      // Replaces any signature, as signtool does.
      sign: ({ path, name, site }) => {
        execFileSync(
          'java',
          [
            '-jar',
            process.env.JSIGN_JAR,
            ...options,
            '--alg',
            'SHA-256',
            '--replace',
            ...(name ? ['--name', name] : []),
            ...(site ? ['--url', site] : []),
            path,
          ],
          { stdio: 'inherit' },
        );
      },
    },
  },
};
