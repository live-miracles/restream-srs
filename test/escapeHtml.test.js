'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { escapeHtml } = require('../public/ts/core/utils');

describe('escapeHtml', () => {
    test('escapes markup, both quote styles and ampersands', () => {
        assert.equal(
            escapeHtml(`<img src=x onerror="a()" onload='b()'>&`),
            '&lt;img src=x onerror=&quot;a()&quot; onload=&#39;b()&#39;&gt;&amp;',
        );
    });

    test('a value interpolated into a single-quoted attribute cannot break out', () => {
        const html = `<input value='${escapeHtml("x' autofocus onfocus='alert(1)")}'>`;
        assert.ok(!/'\s*autofocus/.test(html));
    });
});
