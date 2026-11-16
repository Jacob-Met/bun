import { expect, test } from "bun:test";
import dns from "node:dns";
import dgram from "node:dgram";
import { once } from "node:events";

test("resolve6 distinguishes NODATA from NXDOMAIN", async () => {
  const server = dgram.createSocket("udp4");
  server.on("message", (request, peer) => {
    let offset = 12;
    while (request[offset] !== 0) offset += request[offset] + 1;

    const type = request.readUInt16BE(offset + 1);
    const missingName = request.includes(Buffer.from("missing"));
    const header = Buffer.from(request.subarray(0, 12));
    header.writeUInt16BE(missingName ? 0x8183 : 0x8180, 2);
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(!missingName && type === 1 ? 1 : 0, 6);
    header.writeUInt32BE(0, 8);

    const answer =
      !missingName && type === 1
        ? Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 192, 0, 2, 1])
        : Buffer.alloc(0);
    server.send(Buffer.concat([header, request.subarray(12, offset + 5), answer]), peer.port, peer.address);
  });

  try {
    server.bind(0, "127.0.0.1");
    await once(server, "listening");

    const callbackResolver = new dns.Resolver({ timeout: 1000, tries: 1 });
    callbackResolver.setServers(["127.0.0.1:" + server.address().port]);
    const promiseResolver = new dns.promises.Resolver({ timeout: 1000, tries: 1 });
    promiseResolver.setServers(callbackResolver.getServers());

    const callbackResolve = (hostname: string, recordType: "A" | "AAAA") =>
      new Promise((resolve, reject) => {
        callbackResolver.resolve(hostname, recordType, (error, records) => (error ? reject(error) : resolve(records)));
      });

    // The name exists and has an A record, but no AAAA record.
    expect(await callbackResolve("present.example.test", "A")).toEqual(["192.0.2.1"]);
    expect(await promiseResolver.resolve4("present.example.test")).toEqual(["192.0.2.1"]);

    await expect(callbackResolve("present.example.test", "AAAA")).rejects.toHaveProperty("code", "ENODATA");
    await expect(promiseResolver.resolve6("present.example.test")).rejects.toHaveProperty("code", "ENODATA");

    // NXDOMAIN is distinct: the requested name itself does not exist.
    await expect(callbackResolve("missing.example.test", "AAAA")).rejects.toHaveProperty("code", "ENOTFOUND");
    await expect(promiseResolver.resolve6("missing.example.test")).rejects.toHaveProperty("code", "ENOTFOUND");
  } finally {
    server.close();
  }
});
