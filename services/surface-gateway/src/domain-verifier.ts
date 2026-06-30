import { resolveTxt } from "node:dns/promises";

export interface DomainVerificationResult {
  domain: string;
  spfOk: boolean;
  dkimOk: boolean;
  dmarcOk: boolean;
}

export interface DomainVerifier {
  verify(domain: string): Promise<DomainVerificationResult>;
}

export interface DnsDomainVerifierOptions {
  spfExpected: string;
  dkimSelector: string;
  dkimPublicKey: string;
  resolveTxt?: (hostname: string) => Promise<string[][]>;
}

export class DnsDomainVerifier implements DomainVerifier {
  private readonly spfExpected: string;
  private readonly dkimSelector: string;
  private readonly dkimPublicKey: string;
  private readonly txtResolver: (hostname: string) => Promise<string[][]>;

  public constructor(options: DnsDomainVerifierOptions) {
    this.spfExpected = options.spfExpected;
    this.dkimSelector = options.dkimSelector;
    this.dkimPublicKey = normalizeDnsToken(options.dkimPublicKey);
    this.txtResolver = options.resolveTxt ?? resolveTxt;
  }

  public async verify(domain: string): Promise<DomainVerificationResult> {
    const normalized = normalizeDomain(domain);
    const [spfRecords, dkimRecords, dmarcRecords] = await Promise.all([
      this.lookupTxt(normalized),
      this.lookupTxt(`${this.dkimSelector}._domainkey.${normalized}`),
      this.lookupTxt(`_dmarc.${normalized}`),
    ]);

    return {
      domain: normalized,
      spfOk: spfRecords.some(
        (record) => record.toLowerCase().startsWith("v=spf1") && record.includes(this.spfExpected),
      ),
      dkimOk: dkimRecords.some((record) => {
        const normalizedRecord = normalizeDnsToken(record);
        return (
          normalizedRecord.includes("v=DKIM1") && normalizedRecord.includes(this.dkimPublicKey)
        );
      }),
      dmarcOk: dmarcRecords.some((record) => record.toLowerCase().startsWith("v=dmarc1")),
    };
  }

  private async lookupTxt(hostname: string): Promise<string[]> {
    try {
      return (await this.txtResolver(hostname)).map((record) => record.join(""));
    } catch {
      return [];
    }
  }
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase();
}

function normalizeDnsToken(value: string): string {
  return value.replace(/\s+/g, "");
}
