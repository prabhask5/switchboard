/**
 * Vitest Global Setup
 *
 * Registers @testing-library/jest-dom matchers (toBeInTheDocument,
 * toBeVisible, toHaveTextContent, etc.) globally for all test files.
 * Referenced by `test.setupFiles` in vite.config.ts.
 */
import '@testing-library/jest-dom/vitest';
