# Why Launchfile

## The idea

The idea behind Launchfile dates back to 2013. While building cloud orchestration tools at Rackspace, we kept running into the same problem: every deployment tool described *infrastructure*, not *applications*. We prototyped an app-centric declarative format that worked across providers and learned a lot about what worked and what didn't.

Over a decade later, the gap remains. There are excellent tools for provisioning infrastructure, managing containers, and orchestrating clusters. But none of them answer the simple question a developer asks when they clone a repo: *"what does this app need to run?"*

Launchfile is our answer to that question. We believe every open-source repository should have a file that describes what the app needs — and that file should work on your dev machine, in Docker, on any cloud provider, or even a Raspberry Pi. ([Early thinking from 2013](https://gist.github.com/ziadsawalha/47b30f1b8a8f29631510))

## The hypothesis

It should be possible to declare what an application needs — including multiple services — purely from the app's perspective, completely independent of the provider or platform that fulfills those needs.

A single Launchfile should be enough for a provider to set up everything the app requires, whether that provider runs natively on a developer machine (macOS or Linux), inside Docker, or across any cloud infrastructure.

The declaration describes *what*. The provider decides *how*.

## The landscape

There are many excellent tools in this space, each solving important problems:

- **Docker Compose** is the de facto standard for local container orchestration. It describes containers and their networking — but it requires Docker, and speaks in terms of images and ports rather than application requirements.

- **Helm** is the package manager for Kubernetes. It's powerful for teams already running K8s, but it's specific to that ecosystem.

- **Terraform** and **Pulumi** are industry-leading infrastructure provisioning tools. They excel at describing *infrastructure* — servers, networks, databases — but they operate at the platform level, not the application level.

- **Score** ([score.dev](https://score.dev)) is the closest in spirit, with its "one workload spec, any platform" approach. It's doing great work in the CNCF ecosystem. Where Launchfile differs: we start from source code rather than container images, support multi-service applications in a single file, and include native local development without requiring containers.

- **Cloud Foundry** and **Heroku** pioneered beautifully simple deployment experiences. Their `manifest.yml` and `Procfile` formats showed that developers *want* this level of simplicity. The limitation was that those formats only worked on their respective platforms.

- **OAM** (Open Application Model) by Microsoft and Alibaba explored separating application concerns from infrastructure concerns — a principle we share. Its implementations focused on Kubernetes, which limited the platform-independence the model described.

Each of these tools is valuable. We use many of them ourselves. Launchfile is not a replacement for any of them — it's a layer that doesn't exist yet: a portable, app-centric declaration that any of these tools could consume.

## What makes Launchfile different

- **App-centric, not infra-centric.** Describe what your app needs (`requires: [postgres, redis]`), not how to provision it.
- **Multi-service in one file.** A web server, a worker, and a scheduler are components of one application — they belong in one declaration.
- **Source-first.** Start from a runtime and a start command, not a pre-built container image. Containers are one deployment target, not a prerequisite.
- **Local dev included.** The same Launchfile that deploys to production should set up your development environment natively — no containers required.
- **Truly platform-independent.** Your dev machine (macOS or Linux), a Raspberry Pi, Docker, Kubernetes, any cloud — same file, different providers.
- **Human-writable.** A working Launchfile can be written in under two minutes. If it takes longer, we've failed.
