<script setup lang="ts">
import type { AuditEvent, OpsWindow } from '@newses/shared';
import { mdiAlertCircle, mdiAlert, mdiCheckCircle, mdiDelete } from '@mdi/js';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/vue-query';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../../api.ts';
import { useDurations } from '../../composables/useDurations.ts';
import { formatDateTime, formatRelative } from '../../lib/format.ts';
import { useUiStore } from '../../stores/ui.ts';

const { t, locale } = useI18n();
const ui = useUiStore();
const queryClient = useQueryClient();
const { duration, intervalItems } = useDurations();

const section = ref<'alerts' | 'hosts' | 'jobs' | 'users' | 'audit'>('alerts');
const window = ref<OpsWindow>('24h');
const auditEvent = ref<string | null>(null);

// Statistics are written about once a minute; the page refreshes at the same pace.
const REFRESH_MS = 60_000;
const summary = useQuery({
  queryKey: ['admin', 'ops', 'summary'],
  queryFn: () => api.admin.ops.summary(),
  refetchInterval: REFRESH_MS,
});
const alerts = useQuery({
  queryKey: ['admin', 'ops', 'alerts'],
  queryFn: () => api.admin.ops.alerts(),
  refetchInterval: REFRESH_MS,
  enabled: () => section.value === 'alerts',
});
const hosts = useQuery({
  queryKey: ['admin', 'ops', 'hosts', window],
  queryFn: () => api.admin.ops.hosts(window.value),
  refetchInterval: REFRESH_MS,
  enabled: () => section.value === 'hosts',
});
const siteRules = useQuery({
  queryKey: ['admin', 'sites', 'rules'],
  queryFn: () => api.admin.sites.rules(),
  enabled: () => section.value === 'hosts',
});

/** Admins' minimum interval between feed checks of a site, set from the Sites section. */
const ruleHost = ref('');
const ruleMinutes = ref(60);
const ruleBusy = ref(false);
const ruleIntervals = computed(() => intervalItems.value.filter((item) => item.value !== null));

async function changeRule(work: () => Promise<unknown>) {
  ruleBusy.value = true;
  try {
    await work();
    await queryClient.invalidateQueries({ queryKey: ['admin'] });
  } catch (error) {
    ui.notify(error instanceof ApiError ? error.message : t('errors.generic'), true);
  } finally {
    ruleBusy.value = false;
  }
}

const setRule = () =>
  changeRule(async () => {
    await api.admin.sites.setRule(ruleHost.value.trim(), ruleMinutes.value);
    ruleHost.value = '';
  });
const clearRule = (host: string) => changeRule(() => api.admin.sites.clearRule(host));

const jobs = useQuery({
  queryKey: ['admin', 'ops', 'jobs', window],
  queryFn: () => api.admin.ops.jobs(window.value),
  refetchInterval: REFRESH_MS,
  enabled: () => section.value === 'jobs',
});
const users = useQuery({
  queryKey: ['admin', 'ops', 'users'],
  queryFn: () => api.admin.ops.users(),
  enabled: () => section.value === 'users',
});
const audit = useInfiniteQuery({
  queryKey: ['admin', 'ops', 'audit', auditEvent],
  queryFn: ({ pageParam }) =>
    api.admin.ops.audit({
      ...(pageParam !== undefined && { before: pageParam }),
      ...(auditEvent.value && { event: auditEvent.value }),
    }),
  initialPageParam: undefined as number | undefined,
  getNextPageParam: (page) => page.nextBefore ?? undefined,
  enabled: () => section.value === 'audit',
});
const auditEvents = computed<AuditEvent[]>(
  () => audit.data.value?.pages.flatMap((page) => page.events) ?? [],
);

/** The ops check runs every few minutes (every 30 on AWS); an hour without one means it stopped. */
const STALE_MS = 60 * 60 * 1000;
const stale = computed(() => {
  const checkedAt = summary.data.value?.checkedAt;
  return (
    summary.data.value !== undefined &&
    (!checkedAt || Date.now() - Date.parse(checkedAt) > STALE_MS)
  );
});

const openAlerts = computed(() => alerts.data.value?.filter((a) => !a.resolvedAt) ?? []);
const resolvedAlerts = computed(() => alerts.data.value?.filter((a) => a.resolvedAt) ?? []);

const number = (value: number) => new Intl.NumberFormat(locale.value).format(value);
const percent = (part: number, whole: number) =>
  whole === 0
    ? '–'
    : new Intl.NumberFormat(locale.value, { style: 'percent', maximumFractionDigits: 0 }).format(
        part / whole,
      );
const bytes = (value: number) =>
  new Intl.NumberFormat(locale.value, {
    notation: 'compact',
    style: 'unit',
    unit: value >= 1e6 ? 'megabyte' : 'kilobyte',
    maximumFractionDigits: 1,
  }).format(value >= 1e6 ? value / 1e6 : value / 1e3);
const ms = (value: number) =>
  value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${String(Math.round(value))} ms`;

const hostTrend = computed(() => hosts.data.value?.hourly.map((h) => h.requests) ?? []);
const hostFailures = computed(
  () => hosts.data.value?.hourly.map((h) => h.failures + h.rateLimited) ?? [],
);
const jobTrend = computed(() => jobs.data.value?.hourly.map((h) => h.runs) ?? []);
const jobFailures = computed(() => jobs.data.value?.hourly.map((h) => h.failures) ?? []);
const clientNames = ['web', 'desktop', 'mobile', 'greader', 'ttrss', 'other'];

const AUDIT_EVENTS = [
  'login',
  'login_failed',
  'login_throttled',
  'logout',
  'password_changed',
  'two_factor_enabled',
  'two_factor_disabled',
  'app_password_created',
  'app_password_revoked',
  'user_created',
  'user_updated',
  'user_password_reset',
  'user_deleted',
  'site_interval_set',
  'site_interval_cleared',
];
</script>

<template>
  <section>
    <div class="d-flex align-center flex-wrap ga-2 mb-4">
      <h2 class="text-title-large">{{ t('settings.tabs.operations') }}</h2>
      <v-spacer />
      <span v-if="summary.data.value?.checkedAt" class="text-body-small text-medium-emphasis">
        {{ t('ops.checked', { when: formatRelative(summary.data.value.checkedAt, locale) }) }}
      </span>
    </div>

    <v-alert v-if="stale" type="warning" variant="tonal" density="compact" class="mb-4">
      {{
        summary.data.value?.checkedAt
          ? t('ops.stale', { when: formatRelative(summary.data.value.checkedAt, locale) })
          : t('ops.neverChecked')
      }}
    </v-alert>

    <v-row v-if="summary.data.value" dense class="mb-2">
      <v-col cols="6" sm="3">
        <v-card variant="tonal" :color="summary.data.value.openAlerts > 0 ? 'error' : undefined">
          <v-card-text>
            <div class="text-body-small">{{ t('ops.openAlerts') }}</div>
            <div class="text-headline-small">{{ number(summary.data.value.openAlerts) }}</div>
          </v-card-text>
        </v-card>
      </v-col>
      <v-col cols="6" sm="3">
        <v-card variant="tonal">
          <v-card-text>
            <div class="text-body-small">{{ t('ops.activeUsers') }}</div>
            <div class="text-headline-small">{{ number(summary.data.value.activeUsers) }}</div>
          </v-card-text>
        </v-card>
      </v-col>
      <v-col cols="6" sm="3">
        <v-card variant="tonal">
          <v-card-text>
            <div class="text-body-small">{{ t('ops.apiRequests') }}</div>
            <div class="text-headline-small">{{ number(summary.data.value.requests) }}</div>
            <div class="text-body-small">
              {{
                t(
                  'ops.serverErrors',
                  { count: number(summary.data.value.serverErrors) },
                  summary.data.value.serverErrors,
                )
              }}
            </div>
          </v-card-text>
        </v-card>
      </v-col>
      <v-col cols="6" sm="3">
        <v-card variant="tonal">
          <v-card-text>
            <div class="text-body-small">{{ t('ops.hostRequests') }}</div>
            <div class="text-headline-small">
              {{ number(summary.data.value.outbound.requests) }}
            </div>
            <div class="text-body-small">
              {{
                t(
                  'ops.hostRequestsDetail',
                  {
                    hosts: number(summary.data.value.hosts),
                    notModified: percent(
                      summary.data.value.outbound.notModified,
                      summary.data.value.outbound.requests,
                    ),
                  },
                  summary.data.value.hosts,
                )
              }}
            </div>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>
    <p class="text-body-small text-medium-emphasis mb-4">{{ t('ops.last24h') }}</p>

    <v-tabs v-model="section" density="compact" class="mb-4">
      <v-tab value="alerts">{{ t('ops.sections.alerts') }}</v-tab>
      <v-tab value="hosts">{{ t('ops.sections.hosts') }}</v-tab>
      <v-tab value="jobs">{{ t('ops.sections.jobs') }}</v-tab>
      <v-tab value="users">{{ t('ops.sections.users') }}</v-tab>
      <v-tab value="audit">{{ t('ops.sections.audit') }}</v-tab>
    </v-tabs>

    <v-select
      v-if="section === 'hosts' || section === 'jobs'"
      v-model="window"
      :items="[
        { value: '24h', title: t('ops.window.24h') },
        { value: '7d', title: t('ops.window.7d') },
      ]"
      :label="t('ops.window.label')"
      density="compact"
      hide-details
      class="mb-4 ops-window"
    />

    <template v-if="section === 'alerts'">
      <p v-if="alerts.data.value && openAlerts.length === 0" class="d-flex align-center ga-2 mb-4">
        <v-icon :icon="mdiCheckCircle" color="success" />
        {{ t('ops.noOpenAlerts') }}
      </p>
      <v-list v-if="openAlerts.length > 0" density="compact" class="mb-4">
        <v-list-item v-for="alert in openAlerts" :key="alert.id">
          <template #prepend>
            <v-icon
              :icon="alert.severity === 'critical' ? mdiAlertCircle : mdiAlert"
              :color="alert.severity === 'critical' ? 'error' : 'warning'"
              :aria-label="t(`ops.severity.${alert.severity}`)"
            />
          </template>
          <v-list-item-title class="text-wrap">{{ alert.summary }}</v-list-item-title>
          <v-list-item-subtitle>
            {{ alert.rule }} ·
            {{ t('ops.since', { when: formatRelative(alert.openedAt, locale) }) }}
          </v-list-item-subtitle>
        </v-list-item>
      </v-list>
      <template v-if="resolvedAlerts.length > 0">
        <h3 class="text-title-small mb-2">{{ t('ops.resolvedRecently') }}</h3>
        <v-list density="compact">
          <v-list-item v-for="alert in resolvedAlerts" :key="alert.id">
            <v-list-item-title class="text-wrap">{{ alert.summary }}</v-list-item-title>
            <v-list-item-subtitle>
              {{ alert.rule }} ·
              {{
                t('ops.resolvedAt', {
                  when: formatRelative(alert.resolvedAt ?? alert.lastSeenAt, locale),
                })
              }}
            </v-list-item-subtitle>
          </v-list-item>
        </v-list>
      </template>
    </template>

    <template v-else-if="section === 'hosts' && hosts.data.value">
      <p class="text-body-small mb-2">
        {{ t('ops.hostsHint', { budget: number(hosts.data.value.hourlyBudget) }) }}
      </p>
      <div v-if="hostTrend.length > 1" class="mb-4">
        <v-sparkline
          :model-value="hostTrend"
          color="primary"
          :line-width="2"
          smooth
          fill
          height="40"
        />
        <v-sparkline :model-value="hostFailures" color="error" :line-width="2" smooth height="24" />
        <p class="text-body-small text-medium-emphasis">{{ t('ops.hostTrend') }}</p>
      </div>
      <v-table density="compact">
        <thead>
          <tr>
            <th>{{ t('ops.host') }}</th>
            <th class="text-end">{{ t('ops.requests') }}</th>
            <th class="text-end d-none d-sm-table-cell">{{ t('ops.peakHour') }}</th>
            <th class="text-end d-none d-sm-table-cell">{{ t('ops.notModified') }}</th>
            <th class="text-end">{{ t('ops.errors') }}</th>
            <th class="text-end">{{ t('ops.rateLimited') }}</th>
            <th class="text-end d-none d-md-table-cell">{{ t('ops.downloaded') }}</th>
            <th class="text-end d-none d-md-table-cell">{{ t('ops.average') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="host in hosts.data.value.hosts" :key="host.host">
            <td>
              {{ host.host }}
              <v-chip
                v-if="host.blockedUntil"
                size="x-small"
                color="warning"
                class="ms-1"
                :title="formatDateTime(host.blockedUntil, locale)"
              >
                {{ t('ops.paused') }}
              </v-chip>
              <v-chip
                v-if="host.minIntervalMinutes"
                size="x-small"
                class="ms-1"
                :title="t('ops.siteMinimum')"
              >
                {{ t('ops.siteMinimumChip', { duration: duration(host.minIntervalMinutes) }) }}
              </v-chip>
            </td>
            <td class="text-end">{{ number(host.requests) }}</td>
            <td
              class="text-end d-none d-sm-table-cell"
              :class="{ 'text-error': host.peakHourRequests > hosts.data.value.hourlyBudget }"
            >
              {{ number(host.peakHourRequests) }}
            </td>
            <td class="text-end d-none d-sm-table-cell">
              {{ percent(host.notModified, host.requests) }}
            </td>
            <td class="text-end">
              {{
                number(
                  host.clientErrors +
                    host.serverErrors +
                    host.timeouts +
                    host.networkErrors +
                    host.other,
                )
              }}
            </td>
            <td class="text-end" :class="{ 'text-error': host.rateLimited > 0 }">
              {{ number(host.rateLimited) }}
            </td>
            <td class="text-end d-none d-md-table-cell">{{ bytes(host.bytes) }}</td>
            <td class="text-end d-none d-md-table-cell">{{ ms(host.avgMs) }}</td>
          </tr>
        </tbody>
      </v-table>

      <h3 class="text-title-medium mt-6">{{ t('ops.siteMinimums') }}</h3>
      <p class="text-body-small text-medium-emphasis mb-2">{{ t('ops.siteMinimumsHint') }}</p>
      <v-list v-if="siteRules.data.value?.length" density="compact">
        <v-list-item
          v-for="rule in siteRules.data.value"
          :key="rule.host"
          :title="rule.host"
          :subtitle="t('ops.siteMinimumChip', { duration: duration(rule.minIntervalMinutes) })"
        >
          <template #append>
            <v-btn
              :icon="mdiDelete"
              variant="text"
              size="small"
              :disabled="ruleBusy"
              :aria-label="t('ops.siteMinimumRemove', { host: rule.host })"
              @click="clearRule(rule.host)"
            />
          </template>
        </v-list-item>
      </v-list>
      <v-form class="d-flex flex-wrap align-center ga-2" @submit.prevent="setRule">
        <v-text-field
          v-model="ruleHost"
          :label="t('ops.host')"
          placeholder="example.com"
          density="compact"
          hide-details
          class="flex-grow-1"
        />
        <v-select
          v-model="ruleMinutes"
          :label="t('ops.siteMinimum')"
          :items="ruleIntervals"
          density="compact"
          hide-details
        />
        <v-btn type="submit" :loading="ruleBusy" :disabled="!ruleHost.trim()">
          {{ t('ops.siteMinimumSet') }}
        </v-btn>
      </v-form>
    </template>

    <template v-else-if="section === 'jobs' && jobs.data.value">
      <div v-if="jobTrend.length > 1" class="mb-4">
        <v-sparkline
          :model-value="jobTrend"
          color="primary"
          :line-width="2"
          smooth
          fill
          height="40"
        />
        <v-sparkline :model-value="jobFailures" color="error" :line-width="2" smooth height="24" />
        <p class="text-body-small text-medium-emphasis">{{ t('ops.jobTrend') }}</p>
      </div>
      <v-table density="compact">
        <thead>
          <tr>
            <th>{{ t('ops.job') }}</th>
            <th class="text-end">{{ t('ops.runs') }}</th>
            <th class="text-end">{{ t('ops.failures') }}</th>
            <th class="text-end">{{ t('ops.average') }}</th>
            <th class="text-end">{{ t('ops.longest') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="job in jobs.data.value.jobs" :key="job.job">
            <td>{{ job.job }}</td>
            <td class="text-end">{{ number(job.runs) }}</td>
            <td class="text-end" :class="{ 'text-error': job.failures > 0 }">
              {{ number(job.failures) }}
            </td>
            <td class="text-end">{{ ms(job.avgMs) }}</td>
            <td class="text-end">{{ ms(job.maxMs) }}</td>
          </tr>
        </tbody>
      </v-table>
    </template>

    <template v-else-if="section === 'users' && users.data.value">
      <v-table density="compact">
        <thead>
          <tr>
            <th>{{ t('login.name') }}</th>
            <th>{{ t('ops.lastSeen') }}</th>
            <th class="text-end">{{ t('ops.requests7d') }}</th>
            <th class="text-end d-none d-sm-table-cell">{{ t('ops.requests30d') }}</th>
            <th class="d-none d-md-table-cell">{{ t('ops.clients') }}</th>
            <th class="text-end">{{ t('ops.read7d') }}</th>
            <th class="text-end d-none d-sm-table-cell">{{ t('ops.read30d') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="user in users.data.value" :key="user.id">
            <td>
              {{ user.login }}
              <v-chip v-if="user.disabled" size="x-small" class="ms-1">{{
                t('ops.disabled')
              }}</v-chip>
            </td>
            <td class="text-body-small">
              {{ user.lastSeenAt ? formatRelative(user.lastSeenAt, locale) : t('users.never') }}
            </td>
            <td class="text-end">{{ number(user.requests7d) }}</td>
            <td class="text-end d-none d-sm-table-cell">{{ number(user.requests30d) }}</td>
            <td class="d-none d-md-table-cell text-body-small">
              {{
                clientNames
                  .filter((name) => user.clients[name])
                  .map((name) => `${t(`ops.client.${name}`)} ${number(user.clients[name] ?? 0)}`)
                  .join(', ')
              }}
            </td>
            <td class="text-end">{{ number(user.read7d) }}</td>
            <td class="text-end d-none d-sm-table-cell">{{ number(user.read30d) }}</td>
          </tr>
        </tbody>
      </v-table>
    </template>

    <template v-else-if="section === 'audit'">
      <v-select
        v-model="auditEvent"
        :items="[
          { value: null, title: t('ops.allEvents') },
          ...AUDIT_EVENTS.map((event) => ({ value: event, title: event })),
        ]"
        :label="t('ops.event')"
        density="compact"
        hide-details
        class="mb-4 ops-window"
      />
      <v-table density="compact">
        <thead>
          <tr>
            <th>{{ t('ops.when') }}</th>
            <th>{{ t('ops.event') }}</th>
            <th>{{ t('ops.account') }}</th>
            <th class="d-none d-sm-table-cell">{{ t('ops.by') }}</th>
            <th class="d-none d-md-table-cell">{{ t('ops.address') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="event in auditEvents" :key="event.id">
            <td class="text-body-small text-no-wrap">{{ formatDateTime(event.at, locale) }}</td>
            <td>{{ event.event }}</td>
            <td>{{ event.userLogin ?? (event.details.login as string | undefined) ?? '–' }}</td>
            <td class="d-none d-sm-table-cell">{{ event.actorLogin ?? '' }}</td>
            <td class="d-none d-md-table-cell text-body-small" :title="event.userAgent ?? ''">
              {{ event.ip ?? '' }}
            </td>
          </tr>
        </tbody>
      </v-table>
      <div class="d-flex justify-center mt-2">
        <v-btn
          v-if="audit.hasNextPage.value"
          variant="text"
          :loading="audit.isFetchingNextPage.value"
          @click="audit.fetchNextPage()"
        >
          {{ t('ops.more') }}
        </v-btn>
      </div>
    </template>
  </section>
</template>

<style scoped>
.ops-window {
  max-width: 240px;
}
</style>
