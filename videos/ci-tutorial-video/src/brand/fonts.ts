import {loadFont} from '@remotion/google-fonts/Montserrat';

// Brand weights: 200 display / 400 body / 500 labels / 600 headings / 700 titles
export const {fontFamily} = loadFont('normal', {
  weights: ['200', '400', '500', '600', '700'],
  subsets: ['latin'],
});
