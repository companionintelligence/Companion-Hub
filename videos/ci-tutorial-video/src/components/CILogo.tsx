import React from 'react';
import {Img, staticFile} from 'remotion';

export const CIBanner: React.FC<{height?: number; light?: boolean}> = ({
  height = 80,
  light = false,
}) => (
  <Img
    src={staticFile(
      light
        ? 'logos/2024_CI__Logo_Banner_Color_small-lightmode2.svg'
        : 'logos/2024_CI__Logo_Banner_Color_small.svg',
    )}
    style={{height}}
  />
);

export const CIMark: React.FC<{size?: number}> = ({size = 120}) => (
  <Img
    src={staticFile('logos/2024_CI__LogoMark_Color_med.svg')}
    style={{width: size, height: size, objectFit: 'contain'}}
  />
);
