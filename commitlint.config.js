export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Dependabot titles start with a capital ("Bump ..."), so don't enforce subject case.
    'subject-case': [0],
  },
}
