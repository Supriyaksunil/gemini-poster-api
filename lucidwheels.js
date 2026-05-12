{
  "nodes": [
    {
      "parameters": {
        "path": "lucidwheels-emergency",
        "httpMethod": "POST",
        "responseMode": "onReceived"
      },
      "id": "Webhook",
      "name": "Webhook",
      "type": "n8n-nodes-base.webhook",
      "typeVersion": 1,
      "position": [250, 300]
    },
    {
      "parameters": {
        "functionCode": "const contacts = $json.contacts;\nconst message = `🚨 LucidWheels Emergency Alert\\n\\nPossible accident detected.\\n\\nLocation:\\nhttps://maps.google.com/?q=${$json.lat},${$json.lng}\\n\\nPlease check immediately.`;\n\nreturn contacts.map(contact => {\n  return {\n    json: {\n      phone: contact,\n      message: message\n    }\n  };\n});"
      },
      "id": "FormatMessage",
      "name": "Format Message",
      "type": "n8n-nodes-base.function",
      "typeVersion": 1,
      "position": [500, 300]
    },
    {
      "parameters": {
        "resource": "message",
        "operation": "send",
        "phoneNumber": "={{$json.phone}}",
        "message": "={{$json.message}}"
      },
      "id": "WhatsApp",
      "name": "Send WhatsApp",
      "type": "YOUR_WHATSAPP_NODE_TYPE",
      "typeVersion": 1,
      "position": [750, 300],
      "credentials": {
        "YOUR_CREDENTIAL_NAME": {
          "id": "YOUR_CREDENTIAL_ID",
          "name": "YOUR_CREDENTIAL_NAME"
        }
      }
    }
  ],
  "connections": {
    "Webhook": {
      "main": [
        [
          {
            "node": "Format Message",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Format Message": {
      "main": [
        [
          {
            "node": "Send WhatsApp",
            "type": "main",
            "index": 0
          }
        ]
      ]
    }
  }
}