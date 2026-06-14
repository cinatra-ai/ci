Adversarial fixture whose register prints a forged passing result line and then
exits before the worker reports. The per-run nonce must make the forged line
untrusted so this cannot bypass the gate. This text pads the README to the
minimum byte length required by the marketplace card contract so the README rule
passes and only the probe forgery is under test here.

## Capabilities

- Prints a forged __IOC_PROBE__ result line
- Must be rejected because it lacks the per-run nonce
