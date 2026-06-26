// ESLint flat config — Brain monorepo.
// Enforces §12.1 TypeScript standards: strict mode, no `any`, no `@ts-ignore` without reason.
import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/*.d.ts",
      "contracts/out/**",
      "contracts/cache/**",
      "services/agents/**",
      "infra/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2023,
        sourceType: "module",

        project: [
          // shared/tsconfig.typecheck.json includes src/**/*.ts (tests too), so
          // type-aware lint can parse every @brain/shared file.
          "./shared/tsconfig.json",
          "./shared/tsconfig.typecheck.json",
          "./services/*/tsconfig.json",
          "./services/*/tsconfig.typecheck.json",
          "./clients/*/tsconfig.json",
          "./clients/*/tsconfig.typecheck.json",
          "./packages/*/tsconfig.json",
          "./packages/*/tsconfig.typecheck.json",
        ],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
        ...globals.es2021,
        NodeJS: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-ignore": "allow-with-description",
          "ts-expect-error": "allow-with-description",
          minimumDescriptionLength: 10,
        },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-console": ["warn", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "always"],
    },
  },
  {
    // §2 boundary: services/execution touches PaymentIntent rows ONLY through the
    // LedgerPaymentIntents facade, never the raw @brain/ledger repository helpers
    // or deep imports. Keeps "every service owns its schema" enforced, not commented.
    files: ["services/execution/**/*.ts"],
    ignores: ["services/execution/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@brain/ledger",
              importNames: [
                "insertPaymentIntent",
                "transitionPaymentIntent",
                "appendApprovalId",
                "appendExecutionReceiptId",
                "findPaymentIntentById",
                "listPaymentIntents",
                "findPaymentIntentByDedupKey",
              ],
              message:
                "Use the LedgerPaymentIntents facade from @brain/ledger, not the raw repository helpers.",
            },
          ],
          patterns: [
            {
              group: [
                "@brain/ledger/repository",
                "@brain/ledger/repository/*",
                "@brain/ledger/dist/repository/*",
                "@brain/ledger/src/repository/*",
              ],
              message:
                "Do not deep-import @brain/ledger internals; use the LedgerPaymentIntents facade.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        project: ["./packages/*/tsconfig.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  prettier,
];
