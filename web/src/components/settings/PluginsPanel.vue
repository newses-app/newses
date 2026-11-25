<script setup lang="ts">
import type { Plugin, PluginSettingsState } from '@newses/shared';
import { mdiDelete } from '@mdi/js';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../../api.ts';
import { useErrorText } from '../../composables/useErrorText.ts';
import { useOnlineOnly } from '../../composables/useOnlineOnly.ts';
import { useSession } from '../../composables/useSession.ts';
import { pluginText } from '../../lib/plugin-form.ts';
import { useUiStore } from '../../stores/ui.ts';
import PluginSettingsForm from './PluginSettingsForm.vue';
import PluginTest from './PluginTest.vue';

const { t, locale } = useI18n();
const errorText = useErrorText();
const ui = useUiStore();
const queryClient = useQueryClient();
const { session } = useSession();
const { online, whenOnline } = useOnlineOnly();

const isAdmin = computed(() => session.value?.user.role === 'admin');
const plugins = useQuery({ queryKey: ['plugins'], queryFn: () => api.plugins.list() });
/** The plugin and scope being saved. */
const saving = ref<string | null>(null);

const text = (plugin: Plugin) => (key: string, fallback: string) =>
  pluginText(plugin.messages, locale.value, key, fallback);
const nameOf = (plugin: Plugin) => text(plugin)('name', plugin.id);

async function run(key: string, work: () => Promise<unknown>, done?: string): Promise<void> {
  saving.value = key;
  try {
    await work();
    if (done) ui.notify(done);
  } catch (error) {
    ui.notify(errorText(error), true);
  } finally {
    saving.value = null;
    await queryClient.invalidateQueries({ queryKey: ['plugins'] });
  }
}

const updateInstance = whenOnline(
  (plugin: Plugin, change: Parameters<typeof api.admin.plugins.update>[1], done?: string) =>
    run(`${plugin.id}:instance`, () => api.admin.plugins.update(plugin.id, change), done),
);
const updateMine = whenOnline(
  (plugin: Plugin, change: Parameters<typeof api.account.updatePlugin>[1], done?: string) =>
    run(`${plugin.id}:user`, () => api.account.updatePlugin(plugin.id, change), done),
);

const removeMine = whenOnline(async (plugin: Plugin) => {
  const name = nameOf(plugin);
  if (
    await ui.confirm(
      t('plugins.removeMine'),
      t('plugins.removeMineConfirm', { name }),
      t('plugins.removeMine'),
    )
  )
    await run(
      `${plugin.id}:user`,
      () => api.account.removePlugin(plugin.id),
      t('plugins.removedMine'),
    );
});

const removeSettings = whenOnline(async (id: string) => {
  if (
    await ui.confirm(
      t('plugins.removeSettings'),
      t('plugins.removeSettingsConfirm', { id }),
      t('plugins.removeSettings'),
    )
  )
    await run(`${id}:instance`, () => api.admin.plugins.remove(id), t('plugins.removed'));
});

/** Says why the server turned a plugin off, if it did: what the last run said, or how it failed. */
function turnedOff(state: PluginSettingsState, mine: boolean): string | null {
  if (state.disabledReason !== 'failures') return null;
  if (state.lastFailureDetail)
    return t(mine ? 'plugins.turnedOffMineSaying' : 'plugins.turnedOffSaying', {
      count: state.failures,
      detail: state.lastFailureDetail,
    });
  const failure = t(`plugins.failure.${state.lastFailure ?? 'error'}`);
  return t(mine ? 'plugins.turnedOffMine' : 'plugins.turnedOff', {
    count: state.failures,
    failure,
  });
}

/** "Send test" with the instance's saved settings, or the user's. */
const testServer = (plugin: Plugin) => () => api.admin.plugins.test(plugin.id);
const testMine = (plugin: Plugin) => () => api.account.testPlugin(plugin.id);

/** Shown where the server emails digests (API 1.14). */
const serverInfo = useQuery({
  queryKey: ['server-info'],
  queryFn: () => api.serverInfo(),
  staleTime: Infinity,
});
/** A user's "Send test" of a plugin that adds to digests also emails them a test digest. */
const testsDigest = (plugin: Plugin) =>
  plugin.digests === true && serverInfo.data.value?.digest === true;

const hasMine = (state: PluginSettingsState) =>
  state.enabled || state.secretsSet.length > 0 || Object.keys(state.settings).length > 0;
</script>

<template>
  <section>
    <h2 class="text-title-large mb-4">{{ t('settings.tabs.plugins') }}</h2>
    <v-alert v-if="isAdmin" type="info" variant="tonal" density="compact" class="mb-4">
      {{ t('plugins.experimental') }}
    </v-alert>
    <p
      v-if="plugins.data.value && plugins.data.value.plugins.length === 0"
      class="text-body-medium text-medium-emphasis mb-4"
    >
      {{ isAdmin ? t('plugins.noneInstalled') : t('plugins.noneOn') }}
    </p>

    <v-card
      v-for="plugin in plugins.data.value?.plugins ?? []"
      :key="plugin.id"
      variant="outlined"
      class="mb-4"
    >
      <v-card-item>
        <v-card-title tag="h3" class="text-title-medium">
          <bdi>{{ nameOf(plugin) }}</bdi>
        </v-card-title>
        <v-card-subtitle>
          {{ t('plugins.version', { version: plugin.version }) }}
          <template v-if="plugin.admin">
            · <span dir="ltr">{{ plugin.admin.source }}</span>
          </template>
        </v-card-subtitle>
      </v-card-item>
      <v-card-text>
        <p v-if="text(plugin)('description', '')" class="text-body-medium mb-4" dir="auto">
          {{ text(plugin)('description', '') }}
        </p>

        <template v-if="plugin.admin">
          <h4 class="text-title-small mb-2">{{ t('plugins.serverSettings') }}</h4>
          <v-alert
            v-if="turnedOff(plugin.admin, false)"
            type="warning"
            variant="tonal"
            density="compact"
            class="mb-2"
          >
            {{ turnedOff(plugin.admin, false) }}
          </v-alert>
          <v-switch
            :model-value="plugin.enabled"
            :label="t('plugins.onForServer')"
            :aria-disabled="!online"
            color="primary"
            hide-details
            class="mb-2"
            @update:model-value="(v) => updateInstance(plugin, { enabled: Boolean(v) })"
          />
          <v-combobox
            :model-value="plugin.approvedHosts"
            :items="plugin.hosts"
            :label="t('plugins.approvedHosts')"
            :hint="
              plugin.hosts.length > 0
                ? t('plugins.approvedHostsAsked', { hosts: plugin.hosts.join(', ') })
                : t('plugins.approvedHostsHint')
            "
            persistent-hint
            multiple
            chips
            closable-chips
            dir="ltr"
            class="mb-4"
            @update:model-value="(v: string[]) => updateInstance(plugin, { approvedHosts: v })"
          />
          <PluginSettingsForm
            v-if="plugin.settingsSchemas.instance"
            :schema="plugin.settingsSchemas.instance"
            :state="plugin.admin"
            :text="text(plugin)"
            :approved-hosts="plugin.approvedHosts"
            :saving="saving === `${plugin.id}:instance`"
            :label="t('plugins.serverSettingsOf', { name: nameOf(plugin) })"
            class="mb-4"
            @save="(settings) => updateInstance(plugin, { settings }, t('plugins.saved'))"
          />
          <PluginTest
            v-if="plugin.testable && plugin.enabled && !plugin.settingsSchemas.user"
            :run="testServer(plugin)"
          />
        </template>

        <template v-if="plugin.user && plugin.enabled">
          <h4 class="text-title-small mb-2">{{ t('plugins.mySettings') }}</h4>
          <v-alert
            v-if="turnedOff(plugin.user, true)"
            type="warning"
            variant="tonal"
            density="compact"
            class="mb-2"
          >
            {{ turnedOff(plugin.user, true) }}
          </v-alert>
          <v-switch
            :model-value="plugin.user.enabled"
            :label="t('plugins.onForMe')"
            :aria-disabled="!online"
            color="primary"
            hide-details
            class="mb-2"
            @update:model-value="(v) => updateMine(plugin, { enabled: Boolean(v) })"
          />
          <PluginSettingsForm
            v-if="plugin.settingsSchemas.user"
            :schema="plugin.settingsSchemas.user"
            :state="plugin.user"
            :text="text(plugin)"
            :approved-hosts="plugin.approvedHosts"
            :saving="saving === `${plugin.id}:user`"
            :label="t('plugins.mySettingsOf', { name: nameOf(plugin) })"
            class="mb-2"
            @save="(settings) => updateMine(plugin, { settings }, t('plugins.saved'))"
          />
          <PluginTest
            v-if="
              (plugin.testable || testsDigest(plugin)) &&
              plugin.user.enabled &&
              plugin.settingsSchemas.user
            "
            :run="plugin.testable ? testMine(plugin) : undefined"
            :digest="testsDigest(plugin)"
          />
          <v-btn
            v-if="hasMine(plugin.user)"
            variant="text"
            :prepend-icon="mdiDelete"
            :aria-disabled="!online"
            @click="removeMine(plugin)"
          >
            {{ t('plugins.removeMine') }}
          </v-btn>
        </template>
      </v-card-text>
    </v-card>

    <template v-if="isAdmin && (plugins.data.value?.uninstalled.length ?? 0) > 0">
      <h3 class="text-title-medium mb-1">{{ t('plugins.uninstalled') }}</h3>
      <p class="text-body-medium text-medium-emphasis mb-2">{{ t('plugins.uninstalledHint') }}</p>
      <v-list density="compact">
        <v-list-item v-for="id in plugins.data.value?.uninstalled" :key="id">
          <v-list-item-title dir="ltr">{{ id }}</v-list-item-title>
          <template #append>
            <v-btn
              variant="text"
              :prepend-icon="mdiDelete"
              :aria-disabled="!online"
              @click="removeSettings(id)"
            >
              {{ t('plugins.removeSettings') }}
            </v-btn>
          </template>
        </v-list-item>
      </v-list>
    </template>
  </section>
</template>
