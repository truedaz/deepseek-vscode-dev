from creds import DEEPSEEK_API
from openai import OpenAI

client = OpenAI(api_key=DEEPSEEK_API, base_url="https://api.deepseek.com")

# For quick coding tasks - use chat
response = client.chat.completions.create(
    model="deepseek-chat",
    messages=[
        {"role": "user", "content": "Write a simple Python function to reverse a string"}
    ],
    stream=False
)

# For complex coding tasks - use coder (accept the slower speed)
response = client.chat.completions.create(
    model="deepseek-coder", 
    messages=[
        {"role": "user", "content": "Optimize this algorithm for better time complexity and add type hints"}
    ],
    stream=False
)