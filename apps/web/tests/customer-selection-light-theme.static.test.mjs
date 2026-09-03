import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("src/components/customers/customer-selection-page.tsx", "utf8");
const css = fs.readFileSync("src/app/globals.css", "utf8");

assert.match(source, /customers-search-button/);
assert.match(source, /customers-clear-button/);
assert.match(source, /customers-cart-filter-button/);
assert.match(source, /customers-balance-filter-button/);
assert.match(source, /customers-f-group-trigger/);
assert.match(source, /customer-select-button/);
assert.match(source, /customer-select-button--choose/);
assert.match(source, /customer-select-button--selected/);

assert.match(css, /\/\* Customer selection light theme polish/);
assert.match(css, /html\[data-ui-theme="light"\] \.app-shell-root \.admin-customers-page/);
assert.match(css, /\.admin-customers-page \.customers-search-button:not\(:disabled\)/);
assert.match(css, /\.admin-customers-page \.customers-clear-button:not\(:disabled\)/);
assert.match(css, /\.admin-customers-page \.customer-select-button--choose:not\(:disabled\)/);
assert.match(css, /\.admin-customers-page \.customer-select-button--selected:not\(:disabled\)/);
assert.match(css, /\.admin-customers-page \.admin-customer-list \[data-slot="table-header"\]/);
assert.match(css, /@media \(max-width: 899px\)[\s\S]*html\[data-ui-theme="light"\] \.app-shell-root \.admin-customers-page \.admin-customer-list \[data-slot="table-row"\]/);

assert.doesNotMatch(css, /html\[data-ui-theme="dark"\] \.app-shell-root \.admin-customers-page/);

console.log("customer selection light theme static checks passed");
