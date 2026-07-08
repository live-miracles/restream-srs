'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { isValidIpOrCidr, normalizeIpWhitelist } = require('../src/utils/ipValidation');

describe('isValidIpOrCidr', () => {
    test('accepts bare IPv4/IPv6 addresses', () => {
        assert.ok(isValidIpOrCidr('203.0.113.4'));
        assert.ok(isValidIpOrCidr('::1'));
        assert.ok(isValidIpOrCidr('2001:db8::1'));
    });

    test('accepts CIDR notation within range', () => {
        assert.ok(isValidIpOrCidr('203.0.113.0/24'));
        assert.ok(isValidIpOrCidr('203.0.113.4/32'));
        assert.ok(isValidIpOrCidr('2001:db8::/32'));
        assert.ok(isValidIpOrCidr('2001:db8::/128'));
    });

    test('rejects out-of-range CIDR prefixes', () => {
        assert.equal(isValidIpOrCidr('203.0.113.0/33'), false);
        assert.equal(isValidIpOrCidr('2001:db8::/129'), false);
    });

    test('rejects garbage input', () => {
        assert.equal(isValidIpOrCidr('not-an-ip'), false);
        assert.equal(isValidIpOrCidr(''), false);
        assert.equal(isValidIpOrCidr('203.0.113.4/'), false);
        assert.equal(isValidIpOrCidr('203.0.113.4; rm -rf /'), false);
    });
});

describe('normalizeIpWhitelist', () => {
    test('trims, dedupes, and drops blank lines', () => {
        assert.deepEqual(
            normalizeIpWhitelist([' 203.0.113.4 ', '203.0.113.4', '', '198.51.100.0/24']),
            ['203.0.113.4', '198.51.100.0/24'],
        );
    });

    test('treats a non-array as an empty list', () => {
        assert.deepEqual(normalizeIpWhitelist(undefined), []);
        assert.deepEqual(normalizeIpWhitelist('203.0.113.4'), []);
    });

    test('returns null if any entry is invalid', () => {
        assert.equal(normalizeIpWhitelist(['203.0.113.4', 'not-an-ip']), null);
    });

    test('returns null for a non-string entry', () => {
        assert.equal(normalizeIpWhitelist([123]), null);
    });

    test('returns null past the size cap', () => {
        const many = Array.from({ length: 51 }, (_, i) => `10.0.${i}.1`);
        assert.equal(normalizeIpWhitelist(many), null);
    });
});
