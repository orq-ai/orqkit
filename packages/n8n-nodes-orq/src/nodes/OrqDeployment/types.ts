export interface RawDeploymentListItem {
  id: string;
  key: string;
}

// N8n-specific UI types
export interface OrqContextProperty {
  key: string;
  value: string;
}

export interface OrqInputProperty {
  key: string;
  value: string;
}

export interface OrqMessageProperty {
  role: "user" | "system" | "assistant";
  contentType?: "text" | "image" | "input_audio" | "file";
  message?: string;
  imageSource?: "url" | "base64";
  imageUrl?: string;
  imageData?: string;
  audioData?: string;
  audioFormat?: "wav" | "mp3";
  fileData?: string;
  fileName?: string;
}

export interface OrqFixedCollectionMessages {
  messageProperty: OrqMessageProperty[];
}

export interface OrqFixedCollectionInputs {
  inputProperty: OrqInputProperty[];
}

export interface OrqFixedCollectionContext {
  contextProperty: OrqContextProperty[];
}

export interface OrqCredentials {
  apiKey: string;
}
