import type {
  IAuthenticateGeneric,
  ICredentialTestRequest,
  ICredentialType,
  INodeProperties,
} from "n8n-workflow";

export class OrqApi implements ICredentialType {
  name = "orqApi";
  displayName = "Orq API";
  documentationUrl = "https://docs.orq.ai";
  properties: INodeProperties[] = [
    {
      displayName: "API Key",
      name: "apiKey",
      type: "string",
      typeOptions: {
        password: true,
      },
      default: "",
      required: true,
      description: "Your Orq API key",
    },
    {
      displayName: "Base URL",
      name: "baseUrl",
      type: "string",
      default: "https://api.orq.ai",
      description: "The base URL of the Orq API",
    },
  ];

  authenticate: IAuthenticateGeneric = {
    type: "generic",
    properties: {
      headers: {
        Authorization: '={{"Bearer " + $credentials.apiKey}}',
      },
    },
  };

  test: ICredentialTestRequest = {
    request: {
      baseURL: '={{"" + $credentials.baseUrl}}',
      url: "/v2/deployments",
      method: "GET",
    },
  };
}
