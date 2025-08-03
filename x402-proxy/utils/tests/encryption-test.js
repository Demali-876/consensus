import { ChaChaPoly1305 } from "../encryption.js";
import assert from "assert";

const cipher = new ChaChaPoly1305();
const test = cipher.encrypt("hello world");
console.log('Encrypted:', test);

const decrypted = cipher.decrypt(test);
console.log('Decrypted:', decrypted);

assert.strictEqual("hello world", decrypted);

