import { describe, expect, it } from 'vitest';
import { isHomeFolder, isTopOrHomeFolder } from '../home-folder';

describe('isHomeFolder', () => {
  it.each([
    ['Linux', '/home/ci'],
    ['Linux, with a slash at the end', '/home/ci/'],
    ['Linux, spelled with a dot', '/home/ci/.'],
    ['Linux, spelled through another home', '/home/other/../ci'],
    ['Fedora Atomic', '/var/home/ci'],
    ["root's home", '/root'],
    ['macOS', '/Users/ci'],
    ['macOS, in lower case', '/users/ci'],
    ['Windows', 'C:\\Users\\ci'],
    ['Windows, with forward slashes', 'c:/users/ci'],
    ['Windows, with a backslash at the end', 'D:\\Users\\ci\\'],
    ['Windows through a WSL2 engine', '/mnt/c/Users/ci'],
    ['Windows through Docker Desktop', '/c/Users/ci'],
    ['Windows, as drvfs names it in mountinfo', '/Users/ci'],
  ])('%s: %s', (_shape, folder) => {
    expect(isHomeFolder(folder)).toBe(true);
  });

  it.each([
    ['%APPDATA%\\companion-hub on Windows', 'C:\\Users\\ci\\AppData\\Roaming\\companion-hub'],
    ['%APPDATA%\\companion-hub through a WSL2 engine', '/mnt/c/Users/ci/AppData/Roaming/companion-hub'],
    ['%APPDATA%\\companion-hub through Docker Desktop', '/c/Users/ci/AppData/Roaming/companion-hub'],
    ['the Linux data folder', '/home/ci/.local/share/companion-hub'],
    ['the macOS data folder', '/Users/ci/Library/Application Support/companion-hub'],
    ['a checkout, with the dev compose file', '/home/ci/CI-Hub/.internal'],
    ['the default relative folder', '.internal'],
    ['a folder outside home', '/opt/ci-hub'],
    ['a data disk', '/srv/hub'],
    ['a folder in /root', '/root/ci-hub'],
    ['the folder that holds the homes', '/home'],
    ['a folder named Users elsewhere', '/srv/Users/ci'],
    ['the top of the disk', '/'],
  ])('not %s: %s', (_shape, folder) => {
    expect(isHomeFolder(folder)).toBe(false);
  });
});

describe('isTopOrHomeFolder', () => {
  it.each(['/', '//', '/home/ci', 'C:\\Users\\ci'])('%s', (folder) => {
    expect(isTopOrHomeFolder(folder)).toBe(true);
  });

  it.each(['/opt/ci-hub', 'C:\\Users\\ci\\AppData\\Roaming\\companion-hub', '/mnt/c', 'C:\\'])('not %s', (folder) => {
    expect(isTopOrHomeFolder(folder)).toBe(false);
  });
});
