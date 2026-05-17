import { useState } from 'react';

interface Props {
  onSaveRemote: (endpoint: string, authToken: string, projectName: string) => void;
  onLoadRemote: (endpoint: string, authToken: string, projectName: string) => void;
}

export function StorageRow({ onSaveRemote, onLoadRemote }: Props) {
  const [endpoint, setEndpoint] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [projectName, setProjectName] = useState('default-project');

  return (
    <div className="storage-row">
      <label>
        Contabo storage endpoint
        <input
          type="url"
          placeholder="https://storage.example.com/webhook/clip-stacker"
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
        />
      </label>
      <label>
        Auth token (optional)
        <input
          type="password"
          placeholder="Bearer token or API key"
          value={authToken}
          onChange={(e) => setAuthToken(e.target.value)}
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
