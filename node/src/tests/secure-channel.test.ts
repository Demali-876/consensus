import assert from "node:assert/strict";
import {
  deriveSecureSession,
  generateHandshakeKeyPair,
  openFrame,
  randomHandshakeNonce,
  sealFrame,
} from "../crypto/secure-channel";
import { FRAME_TYPE } from "../tunnel/frames";

const clientKeys = await generateHandshakeKeyPair();
const serverKeys = await generateHandshakeKeyPair();
const clientNonce = randomHandshakeNonce();
const serverNonce = randomHandshakeNonce();

const clientSession = await deriveSecureSession({
  role: "client",
  privateKey: clientKeys.privateKey,
  peerPublicKeyRaw: serverKeys.publicKeyRaw,
  clientNonce,
  serverNonce,
});

const serverSession = await deriveSecureSession({
  role: "server",
  privateKey: serverKeys.privateKey,
  peerPublicKeyRaw: clientKeys.publicKeyRaw,
  clientNonce,
  serverNonce,
});

assert.equal(clientSession.sessionId, serverSession.sessionId);
assert.deepEqual(clientSession.sendKey, serverSession.receiveKey);
assert.deepEqual(serverSession.sendKey, clientSession.receiveKey);

const plaintext = Buffer.from("hello secure tunnel", "utf8");
const sealed = sealFrame(clientSession.sendKey, FRAME_TYPE.DATA, 0n, plaintext);
const opened = openFrame(serverSession.receiveKey, sealed);

assert.equal(opened.frame.type, FRAME_TYPE.DATA);
assert.equal(opened.frame.sequence, 0n);
assert.equal(opened.plaintext.toString("utf8"), plaintext.toString("utf8"));

assert.throws(() => openFrame(serverSession.sendKey, sealed));

console.log("secure-channel ok");
