import { azureClient } from './azure'
import { bitbucketClient } from './bitbucket'
import { githubClient } from './github'
import { gitlabClient } from './gitlab'
import type { ClientConfig, ProviderClient } from './types'

export function clientFor(config: ClientConfig): ProviderClient {
  switch (config.provider) {
    case 'github':
      return githubClient(config)
    case 'gitlab':
      return gitlabClient(config)
    case 'bitbucket':
      return bitbucketClient(config)
    case 'azure':
      return azureClient(config)
  }
}

export type { ClientConfig, ProviderClient } from './types'
