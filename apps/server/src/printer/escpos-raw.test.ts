import { describe, expect, it } from 'vitest';
import { commandeRawSpooler } from './escpos.js';

describe('impression RAW Windows (spooler)', () => {
  it("n'utilise aucun script sur disque : le script part en -EncodedCommand", () => {
    const { args } = commandeRawSpooler('EPSON TM-T20', 'C:\\Temp\\t.bin');
    expect(args).not.toContain('-File');
    const i = args.indexOf('-EncodedCommand');
    expect(i).toBeGreaterThan(-1);
    const script = Buffer.from(args[i + 1]!, 'base64').toString('utf16le');
    expect(script).toContain('$env:POS_RAW_PRINTER');
    expect(script).toContain('WritePrinter');
  });

  it("transmet nom et chemin par l'environnement, jamais dans la commande", () => {
    const nom = "Cuisine'; Remove-Item C:\\ -Recurse; '";
    const { args, env } = commandeRawSpooler(nom, 'C:\\Temp\\t.bin');
    expect(env).toEqual({ POS_RAW_PRINTER: nom, POS_RAW_PATH: 'C:\\Temp\\t.bin' });
    const script = Buffer.from(args[args.indexOf('-EncodedCommand') + 1]!, 'base64').toString('utf16le');
    expect(script).not.toContain('Cuisine');
    expect(args.join(' ')).not.toContain('Cuisine');
  });

  it('reste sous la limite de ligne de commande Windows', () => {
    expect(commandeRawSpooler('x', 'y').args.join(' ').length).toBeLessThan(32_000);
  });
});
