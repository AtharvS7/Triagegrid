import { Fira_Sans, Fira_Code } from "next/font/google";

/** UI text — humanist sans tuned for dense operational data. */
export const firaSans = Fira_Sans({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-sans",
  display: "swap",
});

/** Data figures: tracking codes, callsigns, timers, IDs. Tabular by design. */
export const firaCode = Fira_Code({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});
