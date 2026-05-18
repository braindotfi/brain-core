---
hidden: true
---

# Support

| Channel                | Best for                           | Where                                                                                                |
| ---------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Status page**        | "Is Brain up?"                     | [status.brain.fi](https://status.brain.fi)                                                           |
| **Documentation**      | Reference and guides               | [docs.brain.fi](https://docs.brain.fi)                                                               |
| **GitHub Discussions** | Public questions, integration help | [github.com/braindotfi/brain-core/discussions](https://github.com/braindotfi/brain-core/discussions) |
| **Discord**            | Real-time community help           | [discord.brain.fi](https://discord.brain.fi)                                                         |
| **Email**              | Specific failed requests           | [support@brain.fi](mailto:support@brain.fi)                                                          |
| **Security**           | Vulnerabilities only               | [security@brain.fi](mailto:security@brain.fi)                                                        |

### When opening a ticket

The single most useful thing you can include is a **trace ID**. Every API and MCP response carries one. Pasting a trace ID lets the support team pull the exact request, the policy version that evaluated it, and the audit event that recorded it.

```typescript
try {
  await brain.pay("acme", { invoiceId: "inv_8231" });
} catch (err) {
  console.log(err.traceId);  // include this in the ticket
}
```

### SLAs

| Plan           | First response   | Channels                                 |
| -------------- | ---------------- | ---------------------------------------- |
| **Sandbox**    | Best effort      | Discord, GitHub                          |
| **Developer**  | 1 business day   | Email, Discord                           |
| **Production** | 4 business hours | Email, Discord, dedicated Slack          |
| **Enterprise** | 1 hour, 24/7     | All of the above plus on-call escalation |

### Reporting a security issue

Please email [security@brain.fi](mailto:security@brain.fi) directly. Do not file public issues for security vulnerabilities. Brain runs a public bug bounty; details are on the security page.

