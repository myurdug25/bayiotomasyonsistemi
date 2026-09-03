import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("src/components/customer-card/new-customer-card-page.tsx", "utf8");
const css = fs.readFileSync("src/app/globals.css", "utf8");

assert.match(source, /new-customer-card-page/);
assert.match(source, /new-customer-shell/);
assert.match(source, /new-customer-hero/);
assert.match(source, /new-customer-section/);
assert.match(source, /new-customer-field/);
assert.match(source, /new-customer-select/);
assert.match(source, /new-customer-clear-button/);
assert.match(source, /new-customer-submit-button/);

assert.match(css, /\/\* New customer card light theme polish/);
assert.match(css, /html\[data-ui-theme="light"\] \.app-shell-root \.new-customer-card-page/);
assert.match(css, /\.new-customer-card-page \.new-customer-shell/);
assert.match(css, /\.new-customer-card-page \.new-customer-section/);
assert.match(css, /\.new-customer-card-page \.new-customer-select/);
assert.match(css, /\.new-customer-card-page \.new-customer-submit-button:not\(:disabled\)/);
assert.match(css, /\.new-customer-card-page \.new-customer-clear-button:not\(:disabled\)/);
assert.match(css, /\.new-customer-select-content/);
assert.match(css, /@media \(max-width: 767px\)[\s\S]*\.new-customer-card-page \.new-customer-actions/);

assert.doesNotMatch(css, /html\[data-ui-theme="dark"\] \.app-shell-root \.new-customer-card-page/);

console.log("new customer card light theme static checks passed");
