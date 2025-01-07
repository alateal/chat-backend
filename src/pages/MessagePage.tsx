import { Button, Modal, Form, Input, Radio, message } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useState } from 'react';

function MessagePage() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [form] = Form.useForm();

  const handleCreateChannel = async (values: any) => {
    try {
      setIsLoading(true);
      const response = await fetch('/api/channels', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(values),
      });

      if (!response.ok) throw new Error('Failed to create channel');

      const newChannel = await response.json();
      setChannels([...channels, newChannel]);
      
      message.success('Channel created successfully');
      setIsModalOpen(false);
      form.resetFields();
    } catch (error) {
      message.error('Failed to create channel');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="message-page">
      <div className="channel-header">
        <h2>Channels</h2>
        <Button 
          type="primary" 
          icon={<PlusOutlined />}
          onClick={() => setIsModalOpen(true)}
        >
          New Channel
        </Button>
      </div>

      <Modal
        title="Create New Channel"
        open={isModalOpen}
        onCancel={() => setIsModalOpen(false)}
        footer={null}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={handleCreateChannel}
        >
          <Form.Item
            name="name"
            label="Channel Name"
            rules={[
              { required: true, message: 'Please enter a channel name' },
              { min: 3, message: 'Channel name must be at least 3 characters' }
            ]}
          >
            <Input placeholder="Enter channel name" />
          </Form.Item>

          <Form.Item
            name="description"
            label="Description"
          >
            <Input.TextArea placeholder="Enter channel description (optional)" />
          </Form.Item>

          <Form.Item
            name="type"
            label="Channel Type"
            initialValue="public"
          >
            <Radio.Group>
              <Radio value="public">Public</Radio>
              <Radio value="private">Private</Radio>
            </Radio.Group>
          </Form.Item>

          <Form.Item>
            <Button 
              type="primary" 
              htmlType="submit" 
              loading={isLoading}
              block
            >
              Create Channel
            </Button>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
} 