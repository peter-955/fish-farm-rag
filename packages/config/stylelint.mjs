/** @type {import('stylelint').Config} */
export default {
  extends: ['stylelint-config-standard-scss'],
  rules: {
    // CSS Modules: class names are camelCase or kebab-case, both fine.
    'selector-class-pattern': null,
    'scss/dollar-variable-pattern': null,
  },
};
