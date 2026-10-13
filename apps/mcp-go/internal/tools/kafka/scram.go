package kafka

import (
	"github.com/IBM/sarama"
	"github.com/xdg-go/scram"
)

// scramClient implements sarama.SCRAMClient for SCRAM-SHA-256 and SCRAM-SHA-512.
type scramClient struct {
	conversation *scram.ClientConversation
	hash         scram.HashGeneratorFcn
}

func (c *scramClient) Begin(userName, password, authzID string) error {
	client, err := c.hash.NewClient(userName, password, authzID)
	if err != nil {
		return err
	}
	c.conversation = client.NewConversation()
	return nil
}

func (c *scramClient) Step(challenge string) (string, error) {
	return c.conversation.Step(challenge)
}

func (c *scramClient) Done() bool { return c.conversation.Done() }

func scramGenerator(hash scram.HashGeneratorFcn) func() sarama.SCRAMClient {
	return func() sarama.SCRAMClient {
		return &scramClient{hash: hash}
	}
}
