import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

/**
 * Dynamic Import Configuration for i18n
 * 
 * When to use dynamic imports:
 * - Large applications with many language files (>100KB per language)
 * - Applications where users typically use only one language
 * - When initial load time is critical
 * 
 * Trade-offs:
 * - Pros: Smaller initial bundle size, faster initial page load
 * - Cons: Slight delay when switching languages for the first time
 * 
 * To enable dynamic imports:
 * 1. Set VITE_I18N_DYNAMIC=true in your .env file
 * 2. Import from './i18n-dynamic' instead of './i18n' in main.tsx
 * 
 * Example:
 * ```typescript
 * // main.tsx
 * import './i18n-dynamic'; // Use this for dynamic loading
 * // import './i18n';     // Use this for static loading (default)
 * ```
 */
// Static imports (default for backward compatibility)
import enTranslation from './locales/en.json';
import zhTranslation from './locales/zh.json';

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: {
        translation: enTranslation,
      },
      zh: {
        translation: zhTranslation,
      },
    },
    fallbackLng: 'en',
    detection: {
      // Order of detection methods
      order: ['localStorage', 'navigator', 'htmlTag'],
      // Key to store language preference in localStorage
      lookupLocalStorage: 'preferred-language',
      // Cache the language detection result in localStorage
      caches: ['localStorage'],
    },
    interpolation: {
      escapeValue: true, // Enable for defense-in-depth, even though React provides XSS protection
    },
    react: {
      useSuspense: false, // Disable suspense to use static imports synchronously
    },
  });

export default i18n;
