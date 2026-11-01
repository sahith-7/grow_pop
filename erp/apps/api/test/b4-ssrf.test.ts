import { describe, expect, it } from 'vitest';
import { checkShopUrl, isPrivateAddress, request } from '../src/modules/woocommerce/http.js';
import { testConnection } from '../src/modules/woocommerce/connection.js';

// T2: the shop URL is tenant-controlled and our server calls it. Runs without WOO_DEV_ALLOW_PRIVATE, as production does.

describe('B4 SSRF guard', () => {
  it.each(['10.0.0.5', '127.0.0.1', '169.254.169.254', '172.20.1.1', '192.168.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1',
    'fe80::1', '::ffff:127.0.0.1', '::ffff:a9fe:a9fe', '64:ff9b::a9fe:a9fe'])('refuses %s', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });
  it.each(['8.8.8.8', '13.232.1.1', '2606:4700::1111'])('allows %s', (ip) => expect(isPrivateAddress(ip)).toBe(false));

  it('accepts only https shop addresses on 443, by name', () => {
    expect(checkShopUrl('https://shop.example.com/').toString()).toBe('https://shop.example.com/');
    expect(checkShopUrl('https://example.com/store/').pathname).toBe('/store');
    for (const bad of ['http://shop.example.com', 'https://shop.example.com:8443', 'https://1.2.3.4', 'https://u:p@shop.example.com',
      'https://shop.example.com/?x=1', 'ftp://shop.example.com', 'shop.example.com'])
      expect(() => checkShopUrl(bad), bad).toThrow();
  });

  it('a name that resolves to a private address is refused before connecting', async () => {
    await expect(request(new URL('https://localhost/wp-json/'), { method: 'GET' })).rejects.toMatchObject({ problem: 'private_address' });
    const r = await testConnection({ siteUrl: 'https://localhost', consumerKey: `ck_${'a'.repeat(40)}`, consumerSecret: `cs_${'b'.repeat(40)}` });
    expect(r).toMatchObject({ ok: false, problem: 'private_address' });
  });
});
