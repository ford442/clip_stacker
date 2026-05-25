import { useState } from 'react';

interface Props {
  endpoint: string;
  authToken: string;
  onEndpointChange: (value: string) => void;
  onAuthTokenChange: (value: string) => void;
  onSaveRemote: (endpoint: string, authToken: string, projectName: string) => void;
  onLoadRemote: (endpoint: string, authToken: string, projectName: string) => void;
}

export function StorageRow({ endpoint, authToken, onEndpointChange, onAuthTokenChange, onSaveRemote, onLoadRemote }: Props) {
  const [projectName, setProjectName] = useState('default-project');

  return (
    <div className="storage-row">
      <label>
        Contabo storage endpoint
        <input
          type="url"
          placeholder="https://storage.example.com/webhook/clip-stacker"
          value={endpoint}
          onChange={(e) => onEndpointChange(e.target.value)}
        />
      </label>
      <label>
        Auth token (optional)
        <input
          type="password"
          placeholder="****** or API key"
          value={authToken}
          onChange={(e) => onAuthTokenChange(e.target.value)}
        />
      </label>
      <label>
        Project name
        <input
          type="text"
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
        />
      </label>
      <button type="button" onClick={() => onSaveRemote(endpoint, authToken, projectName)}>
        Save remote
      </button>
      <button type="button" onClick={() => onLoadRemote(endpoint, authToken, projectName)}>
        Load remote
      </button>
    </div>
  );
}
