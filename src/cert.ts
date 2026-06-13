import * as x509 from "@peculiar/x509";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

function derToPem(der: ArrayBuffer, label: string): string {
  const b64 = Buffer.from(der).toString("base64");
  const lines = b64.match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----`;
}

function pemToDer(pem: string): Buffer {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  return Buffer.from(b64, "base64");
}

export class CertManager {
  private caKey: CryptoKey | null = null;
  private caCert: x509.X509Certificate | null = null;
  private caCertPath: string;
  private certsDir: string;
  private certCache = new Map<string, { cert: string; key: string }>();

  constructor(dataDir: string) {
    this.certsDir = join(dataDir, "certs");
    this.caCertPath = join(dataDir, "ca-cert.pem");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(this.certsDir, { recursive: true });
  }

  async initCA() {
    const caKeyPath = join(this.caCertPath, "..", "ca-key.pem");

    if (existsSync(this.caCertPath) && existsSync(caKeyPath)) {
      const certPem = readFileSync(this.caCertPath, "utf-8");
      this.caCert = new x509.X509Certificate(certPem);
      const keyPem = readFileSync(caKeyPath, "utf-8");
      const keyDer = pemToDer(keyPem);
      this.caKey = await crypto.subtle.importKey(
        "pkcs8",
        new Uint8Array(keyDer),
        { name: "RSA-PSS", hash: "SHA-256" },
        false,
        ["sign"],
      );
      console.log("  CA certificate loaded from disk");
      return;
    }

    console.log("  Generating root CA...");

    const caKeyPair = (await crypto.subtle.generateKey(
      {
        name: "RSA-PSS",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      } as any,
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;

    this.caCert = await x509.X509CertificateGenerator.createSelfSigned(
      {
        serialNumber: "01",
        name: "C=US, ST=Dev, L=Proxy, O=Zai Proxy, CN=Zai Proxy CA",
        notBefore: new Date(),
        notAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        keys: caKeyPair,
        extensions: [
          new x509.BasicConstraintsExtension(true, 0, true),
          new x509.KeyUsagesExtension(
            x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
            true,
          ),
        ],
        signingAlgorithm: { name: "RSA-PSS", hash: "SHA-256", saltLength: 32 } as any,
      },
      crypto,
    );

    this.caKey = caKeyPair.privateKey;

    const keyDer = await crypto.subtle.exportKey("pkcs8", this.caKey);
    writeFileSync(caKeyPath, derToPem(keyDer, "PRIVATE KEY"));
    writeFileSync(this.caCertPath, this.caCert.toString());

    console.log("  Root CA generated");
  }

  getCACertPath(): string {
    return this.caCertPath;
  }

  getCACert(): string {
    return this.caCert?.toString() ?? "";
  }

  async getOrCreateCertAsync(domain: string): Promise<{ cert: string; key: string }> {
    const cached = this.certCache.get(domain);
    if (cached) return cached;

    const keyPath = join(this.certsDir, `${domain}.key`);
    const certPath = join(this.certsDir, `${domain}.crt`);

    if (existsSync(keyPath) && existsSync(certPath)) {
      const result = {
        key: readFileSync(keyPath, "utf-8"),
        cert: readFileSync(certPath, "utf-8"),
      };
      this.certCache.set(domain, result);
      return result;
    }

    if (!this.caCert || !this.caKey) throw new Error("CA not initialized");

    const domainKeyPair = (await crypto.subtle.generateKey(
      {
        name: "RSA-PSS",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;

    const serialNumber = Array.from({ length: 16 }, () =>
      Math.floor(Math.random() * 16).toString(16),
    ).join("");

    const domainCert = await x509.X509CertificateGenerator.create(
      {
        serialNumber,
        subject: `C=US, ST=Dev, L=Proxy, O=Zai Proxy, CN=${domain}`,
        issuer: this.caCert.subjectName,
        notBefore: new Date(),
        notAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        signingKey: this.caKey,
        publicKey: domainKeyPair.publicKey,
        signingAlgorithm: { name: "RSA-PSS", hash: "SHA-256", saltLength: 32 } as any,
        extensions: [
          new x509.BasicConstraintsExtension(false),
          new x509.KeyUsagesExtension(
            x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment,
            true,
          ),
          new x509.ExtendedKeyUsageExtension([
            x509.ExtendedKeyUsage.serverAuth,
          ]),
          new x509.SubjectAlternativeNameExtension([
            { type: "dns", value: domain },
            { type: "dns", value: `*.${domain}` },
          ]),
        ],
      },
      crypto,
    );

    const keyDer = await crypto.subtle.exportKey("pkcs8", domainKeyPair.privateKey);
    const keyPem = derToPem(keyDer, "PRIVATE KEY");
    const certPem = domainCert.toString();

    writeFileSync(keyPath, keyPem);
    writeFileSync(certPath, certPem);

    const result = { cert: certPem, key: keyPem };
    this.certCache.set(domain, result);
    return result;
  }
}
