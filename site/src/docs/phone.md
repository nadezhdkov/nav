# On your phone

The Web UI installs on your phone as an app (a PWA). Your phone reaches the daemon over **Tailscale**, and the daemon keeps listening on loopback only.

## Set it up

1. Install Tailscale on the computer that runs Navarch and on your phone, signed in to the same tailnet.
2. On the computer, publish the daemon's port to your tailnet:

   ```sh
   tailscale serve --bg 7420
   navarch remote status      # shows the HTTPS address your phone will use
   ```

3. In the Web UI on the computer, open **Settings → Devices** and create a pairing. Scan the QR code with your phone. The code works once, for five minutes.
4. On the phone, add the page to your home screen.

## Without Tailscale: a relay (preview)

If you cannot use Tailscale, your PC can dial out to a **relay** instead, a small server you host. Phone and PC encrypt everything end to end with a secret that only the pairing QR code carries, so the relay only copies bytes it cannot read or change. It sees which relay id is online, when, and how much data.

```sh
make relay                       # on a server; put a TLS proxy (Caddy, nginx) in front
```

```yaml
# ~/.navarch/config.yaml on your PC
daemon:
  remote:
    mode: relay
    relay_url: https://relay.example.com
```

`navarch remote status` shows whether the PC is connected. Through the relay a phone can do exactly what it can over Tailscale, and the local token never works there. The phone side (a small loader page, and the app delivered by your PC through the encrypted tunnel) is the next step, so pairing a phone over a relay is not possible yet.

## What a phone can do

A paired phone gets its own session: a 15-minute access token and a 30-day refresh token that rotates on every use. Reusing an old refresh token revokes the device.

- See runs, the Fleet, the Inbox, usage and worktree diffs.
- Approve or reject, pause and resume runs, and **stop everything**.
- Start runs from the Inbox, or from a prompt in a registered project.
- **Chat** with the concierge: type, dictate with your browser's speech recognition, or attach text files such as a Markdown note. Changes are proposed first and run only when you confirm them on the phone.
- Get **push notifications**: an approval waiting, a failed or finished run, a budget stop, a quota pause, a new pull request, an agent with a question. Notifications only link to the screen where you decide.

A phone never sees secrets, other devices or pairing. In chat it can start only prompt runs in registered projects or repositories of earlier runs, with the daemon's defaults (no Flow, budget, adapter or attachments), and it reaches only the conversations it opened itself. Revoke it from **Settings → Devices** or with:

```sh
navarch devices
navarch devices revoke <device-id>
```

## Quiet hours

Set `notifications.quiet_hours` in `~/.navarch/config.yaml` to hold notifications at night. Bursts from the same run are grouped within 10 seconds.
