# syntax=docker/dockerfile:1
# The apps build of a checkout, for compose.apps.yaml's apps service: the Linux AppImage and deb and
# the Android APK, which docker/apps-build.sh builds and publishes to the downloads volume when the
# service runs, so the keystore is never in a layer. linux/amd64 only: the Android build tools are
# x86_64 only. Built from the repository root, with apps.Dockerfile.dockerignore.
# The base is pinned to a multi-platform index digest, at the server image's Node version. Change
# the tag and digest together: docker buildx imagetools inspect node:<tag>
ARG NODE_IMAGE=node:24.22.2-trixie-slim@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d

FROM ${NODE_IMAGE}
# JDK 21 for Gradle; the rest for the Android SDK download and electron-builder's AppImage and deb.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      binutils ca-certificates curl openjdk-21-jdk-headless unzip xz-utils \
    && rm -rf /var/lib/apt/lists/*

# The Android SDK, as the release pipeline's Linux leg installs it (mobile/android/variables.gradle),
# with the build tools a Capacitor plugin asks for; Gradle can add others, as the SDK is node's.
# The checksum is the SHA-256 of the file whose SHA-1 Google's repository2-3.xml lists.
ENV ANDROID_HOME=/opt/android-sdk \
    JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
ARG CMDLINE_TOOLS=commandlinetools-linux-11076708_latest.zip
ARG CMDLINE_TOOLS_SHA256=2d2d50857e4eb553af5a6dc3ad507a17adf43d115264b1afc116f95c92e5e258
RUN set -eu; \
    curl -fsSL -o /tmp/cmdline-tools.zip "https://dl.google.com/android/repository/$CMDLINE_TOOLS"; \
    echo "$CMDLINE_TOOLS_SHA256  /tmp/cmdline-tools.zip" | sha256sum -c -; \
    mkdir -p "$ANDROID_HOME/cmdline-tools"; \
    unzip -q /tmp/cmdline-tools.zip -d "$ANDROID_HOME/cmdline-tools"; \
    mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"; \
    rm /tmp/cmdline-tools.zip; \
    (yes || true) | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --licenses >/dev/null; \
    "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" \
      'platforms;android-36' 'build-tools;36.0.0' 'build-tools;35.0.0' platform-tools >/dev/null; \
    chown -R node:node "$ANDROID_HOME"

RUN corepack enable
# The service's volumes start from these, owned by the build's user: Gradle's and the Electron
# downloads' caches, and the downloads the server serves.
RUN mkdir -p /src /home/node/.gradle /home/node/.cache /data/downloads \
    && chown node:node /src /home/node/.gradle /home/node/.cache /data/downloads
USER node
WORKDIR /src
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
COPY --chown=node:node . .
RUN --mount=type=cache,id=apps-pnpm-store,target=/home/node/.local/share/pnpm/store,uid=1000,gid=1000 \
    pnpm install --frozen-lockfile
ENTRYPOINT ["bash", "docker/apps-build.sh"]
