/**
 * Provision the opt-in Hono lab. Hono authenticates devices; Ditto enforces
 * that the authenticated device_id equals the thing addressed by the payload.
 * A transport receipt never becomes a reconciler actuation acknowledgement.
 *
 * Reruns preserve the twin. Registry credentials and connection configuration
 * are deliberately reconciled to the local lab configuration.
 */
export const TENANT = 'energy';
export const DEVICE = 'energy:edge-0001';
export const CONNECTION = 'hono-energy';
export const SUBJECT = 'hono:energy';
export const ADMIN = 'nginx:reconciler';

export function connectionConfig() {
  const commandHeaders = {
    device_id: '{{ thing:id }}',
    subject: '{{ header:subject | fn:default(topic:action-subject) | fn:default(topic:criterion) }}',
    'correlation-id': '{{ header:correlation-id }}',
    'response-required': '{{ header:response-required }}',
  };
  return {
    id: CONNECTION,
    name: 'Local Eclipse Hono transport',
    connectionType: 'kafka',
    connectionStatus: 'open',
    uri: 'tcp://hono-kafka:9092',
    failoverEnabled: true,
    clientCount: 1,
    specificConfig: { bootstrapServers: 'hono-kafka:9092', groupId: CONNECTION },
    sources: [
      {
        addresses: [`hono.telemetry.${TENANT}`, `hono.event.${TENANT}`, `hono.command_response.${TENANT}`],
        consumerCount: 1,
        qos: 1,
        authorizationContext: [SUBJECT],
        enforcement: { input: '{{ header:device_id }}', filters: ['{{ entity:id }}'] },
        payloadMapping: ['Ditto'],
        replyTarget: {
          enabled: true,
          address: `hono.command.${TENANT}/{{ thing:id }}`,
          headerMapping: {
            ...commandHeaders,
            subject:
              '{{ header:subject | fn:default(topic:action-subject) | fn:default(topic:criterion) }}-response',
          },
          expectedResponseTypes: ['response', 'error', 'nack'],
        },
      },
    ],
    targets: [
      {
        address: `hono.command.${TENANT}/{{ thing:id }}`,
        topics: ['_/_/things/twin/events', '_/_/things/live/messages', '_/_/things/live/commands'],
        authorizationContext: [SUBJECT],
        headerMapping: commandHeaders,
      },
    ],
  };
}

export async function provision(
  registry = process.env['HONO_REGISTRY_URL'] ?? 'http://localhost:28080',
  ditto = process.env['DITTO_URL'] ?? 'http://localhost:8080',
): Promise<void> {
  async function request(
    base: string,
    path: string,
    method: string,
    body: unknown,
    allowed: number[],
    devops = false,
  ) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(base === ditto
          ? devops
            ? {
                authorization: `Basic ${Buffer.from(`devops:${process.env['DITTO_DEVOPS_PASSWORD'] ?? 'foobar'}`).toString('base64')}`,
              }
            : { 'x-ditto-pre-authenticated': ADMIN }
          : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!allowed.includes(response.status)) {
      throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    }
    return response;
  }
  await request(
    registry,
    `/v1/tenants/${TENANT}`,
    'POST',
    { ext: { 'messaging-type': 'kafka' } },
    [201, 409],
  );
  await request(registry, `/v1/devices/${TENANT}/${encodeURIComponent(DEVICE)}`, 'POST', {}, [201, 409]);
  await request(
    registry,
    `/v1/credentials/${TENANT}/${encodeURIComponent(DEVICE)}`,
    'PUT',
    [
      {
        type: 'hashed-password',
        'auth-id': 'edge_0001',
        secrets: [{ 'pwd-plain': 'secret' }],
      },
    ],
    [204],
  );
  await request(
    ditto,
    `/api/2/policies/${DEVICE}`,
    'PUT',
    {
      entries: {
        admin: {
          subjects: { [ADMIN]: { type: 'local application' } },
          resources: {
            'thing:/': { grant: ['READ', 'WRITE'], revoke: [] },
            'policy:/': { grant: ['READ', 'WRITE'], revoke: [] },
            'message:/': { grant: ['READ', 'WRITE'], revoke: [] },
          },
        },
        device: {
          subjects: { [SUBJECT]: { type: 'Hono connection' } },
          resources: {
            'thing:/': { grant: ['READ', 'WRITE'], revoke: [] },
            'message:/': { grant: ['READ', 'WRITE'], revoke: [] },
          },
        },
      },
    },
    [201, 204],
  );
  const existing = await fetch(`${ditto}/api/2/things/${DEVICE}`, {
    headers: { 'x-ditto-pre-authenticated': ADMIN },
    signal: AbortSignal.timeout(10_000),
  });
  if (existing.status === 404) {
    await request(
      ditto,
      `/api/2/things/${DEVICE}`,
      'PUT',
      {
        policyId: DEVICE,
        features: { charging: { properties: { charging: false }, desiredProperties: { charging: false } } },
      },
      [201],
    );
  } else if (!existing.ok) throw new Error(`Reading edge twin: ${existing.status}`);
  await request(ditto, `/api/2/connections/${CONNECTION}`, 'PUT', connectionConfig(), [201, 204], true);
}

if (import.meta.main) {
  await provision();
  console.log(`Provisioned Hono tenant ${TENANT}, device ${DEVICE}, and Ditto connection ${CONNECTION}`);
}
