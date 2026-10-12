# Sourced by scripts that act on the AWS deployment: reads its account-specific values from
# infra/deploy.config.json (or the file NEWSES_DEPLOY_CONFIG names).

deploy_config_file() {
  local file=${NEWSES_DEPLOY_CONFIG:-$(dirname "${BASH_SOURCE[0]}")/../../infra/deploy.config.json}
  [ -f "$file" ] || {
    echo "no deployment config at $file: copy infra/deploy.config.example.json and fill it in" >&2
    return 2
  }
  echo "$file"
}

# A top-level value of the deployment config, e.g. `deploy_value region`.
deploy_value() {
  local file
  file=$(deploy_config_file) || return
  node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]])' \
    "$file" "$1"
}

# The deployment's AWS region.
deploy_region() { deploy_value region; }

# The prefix of the deployment's physical names and parameter paths.
deploy_prefix() { deploy_value resourcePrefix; }

# The deployment's prefix when there is a config, else the project's name; for defaults that must
# match what an earlier run created.
name_prefix() { deploy_prefix 2>/dev/null || echo newses; }

# The domain of the stage named $1, failing when the deployment has no such stage.
stage_domain() {
  local file
  file=$(deploy_config_file) || return
  node -e '
    const config = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const stage = config.stages.find((s) => s.name === process.argv[2]);
    if (!stage) {
      console.error(`the deployment has no ${process.argv[2]} stage`);
      process.exit(2);
    }
    console.log(stage.domainName);
  ' "$file" "$1"
}
