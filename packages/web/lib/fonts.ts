import { Instrument_Serif, JetBrains_Mono } from 'next/font/google';

export const jetbrainsMono = JetBrains_Mono({
  subsets: [
    'latin',
  ],
  display: 'swap',
  variable: '--font-mono',
});

export const instrumentSerif = Instrument_Serif({
  subsets: [
    'latin',
  ],
  weight: '400',
  style: [
    'normal',
    'italic',
  ],
  display: 'swap',
  variable: '--font-serif',
});
