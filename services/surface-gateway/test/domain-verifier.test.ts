import { describe, expect, it } from "vitest";
import { DnsDomainVerifier } from "../src/domain-verifier.js";

describe("DnsDomainVerifier", () => {
  it("requires SPF, DKIM, and DMARC records to match configured Brain values", async () => {
    const verifier = new DnsDomainVerifier({
      spfExpected: "include:mail.brain.fi",
      dkimSelector: "brain",
      dkimPublicKey: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A",
      async resolveTxt(hostname) {
        if (hostname === "example.com") {
          return [["v=spf1 include:mail.brain.fi -all"]];
        }
        if (hostname === "brain._domainkey.example.com") {
          return [["v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A"]];
        }
        if (hostname === "_dmarc.example.com") {
          return [["v=DMARC1; p=quarantine"]];
        }
        return [];
      },
    });

    await expect(verifier.verify("Example.com")).resolves.toEqual({
      domain: "example.com",
      spfOk: true,
      dkimOk: true,
      dmarcOk: true,
    });
  });

  it("fails closed when any expected DNS proof is absent", async () => {
    const verifier = new DnsDomainVerifier({
      spfExpected: "include:mail.brain.fi",
      dkimSelector: "brain",
      dkimPublicKey: "expected-key",
      async resolveTxt(hostname) {
        if (hostname === "example.com") return [["v=spf1 include:other.example -all"]];
        if (hostname === "brain._domainkey.example.com") return [["v=DKIM1; p=wrong-key"]];
        return [];
      },
    });

    await expect(verifier.verify("example.com")).resolves.toEqual({
      domain: "example.com",
      spfOk: false,
      dkimOk: false,
      dmarcOk: false,
    });
  });
});
