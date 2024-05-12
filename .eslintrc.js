/* eslint-env node */
module.exports = {
	env: {
		'node': true,
		'es6': true,
		'jest/globals': true,
	},
	ignorePatterns: ['lib/**/*'],
	extends: ['@evanpurkhiser/eslint-config/common'],
	plugins: ['jest'],
	rules: {
		'simple-import-sort/imports': 'off',
	},
};
