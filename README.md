# Watch Room v5

This build focuses on older Safari / iPad behavior and removes the negotiation race that was causing:
- `description type incompatible with current signaling state`
- endless `connecting` / `receiving`
- host camera or screen not appearing on the iPad viewer

## What changed
- host is now the only side that creates offers
- viewer only answers offers
- separate negotiation queues for screen/audio and host camera
- queued ICE candidates until remote descriptions are ready
- host preview stays visible for both shared screen and host camera
- short 6-character room codes remain
- live room list remains
- optional password remains
- optional TURN relay support via environment variables

## Run
```bash
npm install
npm start
```

## Optional TURN relay
STUN alone is often not enough on some mobile / carrier / strict NAT networks.
You can add TURN on Render or locally with these env vars:

```bash
TURN_URL=turn:your-turn-server:3478?transport=udp,turn:your-turn-server:3478?transport=tcp
TURN_USERNAME=your_username
TURN_CREDENTIAL=your_password
```

The app automatically exposes those ICE servers to the browser through `/config.js`.

## Important iPad note
Use real Safari on the iPad when possible. In-app browsers and some wrappers can still break WebRTC behavior.
