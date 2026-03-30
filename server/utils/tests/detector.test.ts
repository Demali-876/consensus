import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyDeviceIps, type DeviceIpObservation } from '../../features/ip-pool/detector.js';
import { depositObservation } from '../../features/ip-pool/pool.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function observation(
  observedAt: number,
  ipv4: string | null,
  ipv6: string | null,
): DeviceIpObservation {
  return {
    observedAt,
    publicIps: { ipv4, ipv6 },
    localAssignment: 'dhcp',
  };
}

describe('IP detector', () => {
  it('classifies repeated IPv4 changes as dynamic at the device level', () => {
    const history: DeviceIpObservation[] = [
      observation(1 * DAY, '198.51.100.10', '2603:7081:7a3e:ba00:1111:1111:1111:1111'),
      observation(2 * DAY, '198.51.100.11', '2603:7081:7a3e:ba00:2222:2222:2222:2222'),
    ];

    const clue = classifyDeviceIps({
      current: {
        observedAt: 3 * DAY,
        publicIps: {
          ipv4: '198.51.100.12',
          ipv6: '2603:7081:7a3e:ba00:3333:3333:3333:3333',
        },
        localAssignment: 'dhcp',
        reverseDns: {
          ipv4: ['pool-198-51-100.example.net'],
        },
      },
      history,
    });

    assert.equal(clue.kind, 'dynamic');
    assert.ok(clue.evidence.ipv4Changes >= 2);
  });

  it('does not promote IPv6 privacy rotation to static before the 7-day window', () => {
    const history: DeviceIpObservation[] = [
      observation(0 * DAY, null, '2603:7081:7a3e:ba00:1111:1111:1111:1111'),
      observation(2 * DAY, null, '2603:7081:7a3e:ba00:2222:2222:2222:2222'),
      observation(4 * DAY, null, '2603:7081:7a3e:ba00:3333:3333:3333:3333'),
    ];

    const clue = classifyDeviceIps({
      current: observation(5 * DAY, null, '2603:7081:7a3e:ba00:4444:4444:4444:4444'),
      history,
    });

    assert.equal(clue.kind, 'dynamic');
    assert.equal(clue.evidence.ipv6PrefixChanges, 0);
    assert.equal(clue.evidence.uniqueIpv6Prefixes, 1);
  });

  it('promotes to static after a 7-day stable IPv6 prefix window', () => {
    const history: DeviceIpObservation[] = [
      observation(0 * DAY, null, '2603:7081:7a3e:ba00:1111:1111:1111:1111'),
      observation(2 * DAY, null, '2603:7081:7a3e:ba00:2222:2222:2222:2222'),
      observation(5 * DAY, null, '2603:7081:7a3e:ba00:3333:3333:3333:3333'),
    ];

    const clue = classifyDeviceIps({
      current: observation(8 * DAY, null, '2603:7081:7a3e:ba00:4444:4444:4444:4444'),
      history,
    });

    assert.equal(clue.kind, 'static');
    assert.ok(clue.staticConfidence >= 0.9);
  });

  it('defaults to dynamic when there is only one snapshot and only soft residential signals', () => {
    const clue = classifyDeviceIps({
      current: {
        observedAt: 6 * HOUR,
        publicIps: {
          ipv4: '69.201.60.251',
          ipv6: '2603:7081:7a3e:ba00:b91c:3dd4:8c80:236c',
        },
        localAssignment: 'dhcp',
        reverseDns: {
          ipv4: ['syn-069-201-060-251.res.spectrum.com'],
          ipv6: ['syn-2603-7081-7a3e-ba00-b91c-3dd4-8c80-236c.res6.spectrum.com'],
        },
      },
      history: [],
    });

    assert.equal(clue.kind, 'dynamic');
    assert.ok(clue.staticConfidence < 0.75);
  });

  it('pool deposit classifies on write', () => {
    const history: DeviceIpObservation[] = [
      observation(0 * DAY, '203.0.113.44', '2603:7081:7a3e:ba00:aaaa:aaaa:aaaa:aaaa'),
      observation(3 * DAY, '203.0.113.44', '2603:7081:7a3e:ba00:bbbb:bbbb:bbbb:bbbb'),
      observation(6 * DAY, '203.0.113.44', '2603:7081:7a3e:ba00:cccc:cccc:cccc:cccc'),
    ];

    const result = depositObservation(
      {
        observedAt: 8 * DAY,
        publicIps: {
          ipv4: '203.0.113.44',
          ipv6: '2603:7081:7a3e:ba00:dddd:dddd:dddd:dddd',
        },
        localAssignment: 'manual',
      },
      { history, persist: false },
    );

    assert.equal(result.history.length, 4);
    assert.equal(result.clue.kind, 'static');
  });
});
